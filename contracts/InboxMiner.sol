// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";
import "./InboxEstimateGas.sol";
import "./MinerBase.sol";
import "./lib/MinerRejectLib.sol";

/// @title InboxMiner
/// @notice Miner-driven inbox: ingest mined payloads, execute targets, and collect fees.
/// @dev Inherits {InboxEstimateGas} for {estimateExecutionGasForMiner} and estimate-mode hooks.
abstract contract InboxMiner is InboxEstimateGas, MinerBase, IInboxMiner, ReentrancyGuard {
    error NoncesNotContiguous();
    error RequestAlreadyProcessed();

    using MinerRejectLib for IInbox.MpcMethodCall;
    /// @notice Gas reserved after the target subcall so failure accounting can always commit.
    uint256 private constant POST_CALL_GAS_RESERVE = 200_000;

    /// @notice Gas reserved after an estimate subcall so {ExecutionGasEstimate} can always encode.
    uint256 private constant ESTIMATE_OUTER_RESERVE = 150_000;

    /// @notice Pause or unpause messaging (owner-only emergency stop).
    /// @param paused True to halt outbound sends and {batchProcessRequests}.
    function setMessageProcessingPaused(bool paused) external onlyOwner {
        messageProcessingPaused = paused;
        emit MessageProcessingPausedUpdated(paused);
    }

    /// @inheritdoc IInboxMiner
    function setVerifier(address verifier_) external onlyOwner {
        verifier = verifier_;
        emit VerifierUpdated(verifier_);
    }

    /// @inheritdoc IInboxMiner
    function hashBatch(uint256 sourceChainId, MinedRequest[] calldata mined) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), sourceChainId, keccak256(abi.encode(mined))));
    }

    function _requireVerifierSignature(
        uint256 sourceChainId,
        MinedRequest[] memory mined,
        bytes calldata verifierSignature
    ) private view {
        address expected = verifier;
        if (expected == address(0)) revert VerifierNotSet();
        if (verifierSignature.length != 65) revert InvalidVerifierSignature();
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), sourceChainId, keccak256(abi.encode(mined))));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let ptr := verifierSignature.offset
            r := calldataload(ptr)
            s := calldataload(add(ptr, 32))
            v := byte(0, calldataload(add(ptr, 64)))
        }
        if (v < 27) {
            unchecked {
                v += 27;
            }
        }
        if (ecrecover(digest, v, r, s) != expected) revert InvalidVerifierSignature();
    }

    /// @inheritdoc IInboxMiner
    /// @dev Reject items require targetContract==0 and MinerRejectLib.parse success; nonzero target never rejects.
    function batchProcessRequests(
        uint256 sourceChainId,
        MinedRequest[] memory mined,
        bytes calldata verifierSignature
    )
        external
        onlyMiner
        nonReentrant
    {
        if (messageProcessingPaused) {
            revert MessageProcessingPaused();
        }
        if (sourceChainId == chainId) {
            revert SourceChainIsThisChain(chainId);
        }
        _requireVerifierSignature(sourceChainId, mined, verifierSignature);

        // Ingest caps invert create-time peer roles: targetFee executes here (local),
        // callerFee funds the return leg on the peer (remote).
        FeeConfig memory localCaps = _localMinFeeConfigMem();
        FeeConfig memory remoteCaps = _remoteMinFeeConfigMem();
        uint256 maxMethodCallBytes = localCaps.maxMethodCallBytes;
        uint256 maxLocalExecutionGas = localCaps.maxExecutionGas;
        uint256 maxRemoteExecutionGas = remoteCaps.maxExecutionGas;

        uint256 allowedNonce = 1;
        if (lastIncomingRequestId[sourceChainId] != bytes32(0)) {
            (,, allowedNonce) = _unpackRequestId(lastIncomingRequestId[sourceChainId]);
            allowedNonce++;
        }

        for (uint256 i = 0; i < mined.length;) {
            MinedRequest memory minedRequest = mined[i];
            bytes32 requestId = minedRequest.requestId;
            _requireRequestIdVersion(requestId);
            (uint256 minedChainId, uint256 minedTargetChainId, uint256 minedNonce) = _unpackRequestId(requestId);
            if (minedChainId != sourceChainId) {
                revert RequestSourceChainMismatch(requestId, sourceChainId, minedChainId);
            }
            if (minedTargetChainId != chainId) {
                revert RequestTargetChainMismatch(requestId, chainId, minedTargetChainId);
            }
            if (minedNonce != allowedNonce) revert NoncesNotContiguous();
            unchecked {
                ++allowedNonce;
            }
            Request storage incomingRequest = incomingRequests[requestId];
            if (incomingRequest.requestId != bytes32(0)) revert RequestAlreadyProcessed();
            if (minedRequest.sourceContract == address(0)) revert InvalidSourceContract();

            // PF-L1: reject is miner-only via targetContract==0 + sentinel methodCall.
            // Never treat a nonzero-target user payload as reject (raw 0xff||… collision).
            if (minedRequest.targetContract == address(0)) {
                (bool isReject, uint8 rejectionCode, bytes32 rejectionReason) =
                    MinerRejectLib.parse(minedRequest.methodCall);
                if (!isReject) revert InvalidTargetContract();
                _ingestMinerReject(
                    incomingRequest,
                    minedRequest,
                    sourceChainId,
                    requestId,
                    rejectionCode,
                    rejectionReason
                );
            } else {
                uint256 weight = MinerRejectLib.structuralSize(minedRequest.methodCall);
                if (weight > maxMethodCallBytes) {
                    revert MethodCallTooLarge(weight, maxMethodCallBytes);
                }
                if (minedRequest.targetFee > maxLocalExecutionGas) {
                    revert FeeGasTooHigh(minedRequest.targetFee, maxLocalExecutionGas);
                }
                if (minedRequest.callerFee > maxRemoteExecutionGas) {
                    revert FeeGasTooHigh(minedRequest.callerFee, maxRemoteExecutionGas);
                }

                Request memory newIncomingRequest = Request({
                    requestId: requestId,
                    targetChainId: sourceChainId,
                    targetContract: minedRequest.targetContract,
                    methodCall: minedRequest.methodCall,
                    callerContract: minedRequest.sourceContract,
                    originalSender: minedRequest.sourceContract,
                    timestamp: uint64(block.timestamp),
                    callbackSelector: minedRequest.callbackSelector,
                    errorSelector: minedRequest.errorSelector,
                    isTwoWay: minedRequest.isTwoWay,
                    executed: false,
                    sourceRequestId: minedRequest.sourceRequestId,
                    targetFee: minedRequest.targetFee,
                    callerFee: minedRequest.callerFee
                });

                incomingRequests[requestId] = newIncomingRequest;
                (
                    bytes4 methodSelector,
                    bytes32 methodCallHash,
                    uint256 dataLength,
                    uint16 datatypeCount,
                    uint16 datalenCount
                ) = _methodCallLogData(minedRequest.methodCall);
                emit MessageReceived(
                    requestId,
                    sourceChainId,
                    minedRequest.sourceContract,
                    methodSelector,
                    methodCallHash,
                    dataLength,
                    datatypeCount,
                    datalenCount
                );

                _executeIncomingRequest(incomingRequest, sourceChainId);

                if (incomingRequest.requestId != bytes32(0) && incomingRequest.sourceRequestId != bytes32(0)
                    && !incomingRequest.isTwoWay) {
                    bytes32 originalRequestId = incomingRequest.sourceRequestId;
                    Request storage originalRequest = requests[originalRequestId];

                    if (originalRequest.requestId != bytes32(0) && !originalRequest.executed) {
                        originalRequest.executed = true;
                        emit IncomingResponseReceived(originalRequestId, incomingRequest.requestId);
                        if (errors[incomingRequest.requestId].requestId == bytes32(0)) {
                            emit ReturnLegCallbackSucceeded(originalRequestId, incomingRequest.requestId);
                        }
                    }
                }
            }
            unchecked {
                ++i;
            }
        }

        if (mined.length > 0) {
            lastIncomingRequestId[sourceChainId] = mined[mined.length - 1].requestId;
        }
    }

    /// @dev Contiguous reject: store header only (empty methodCall), emit, system-error if two-way.
    function _ingestMinerReject(
        Request storage incomingRequest,
        MinedRequest memory minedRequest,
        uint256 sourceChainId,
        bytes32 requestId,
        uint8 rejectionCode,
        bytes32 rejectionReason
    ) private {
        MpcMethodCall memory emptyCall;

        incomingRequests[requestId] = Request({
            requestId: requestId,
            targetChainId: sourceChainId,
            targetContract: minedRequest.targetContract,
            methodCall: emptyCall,
            callerContract: minedRequest.sourceContract,
            originalSender: minedRequest.sourceContract,
            timestamp: uint64(block.timestamp),
            callbackSelector: minedRequest.callbackSelector,
            errorSelector: minedRequest.errorSelector,
            isTwoWay: minedRequest.isTwoWay,
            executed: true,
            sourceRequestId: minedRequest.sourceRequestId,
            targetFee: minedRequest.targetFee,
            callerFee: minedRequest.callerFee
        });

        bytes memory reasonBytes = abi.encodePacked(rejectionReason);
        errors[requestId] = Error({
            requestId: requestId,
            errorCode: ERROR_CODE_MINER_REJECTED,
            errorMessage: reasonBytes
        });
        emit RequestRejected(requestId, rejectionCode, rejectionReason);
        emit ErrorReceived(requestId, ERROR_CODE_MINER_REJECTED, reasonBytes);

        if (minedRequest.isTwoWay) {
            _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_MINER_REJECTED, reasonBytes);
        }

        if (incomingRequest.sourceRequestId != bytes32(0) && !incomingRequest.isTwoWay) {
            bytes32 originalRequestId = incomingRequest.sourceRequestId;
            Request storage originalRequest = requests[originalRequestId];
            if (originalRequest.requestId != bytes32(0) && !originalRequest.executed) {
                originalRequest.executed = true;
                emit IncomingResponseReceived(originalRequestId, incomingRequest.requestId);
            }
        }
    }

    /// @notice Configure the oracle used for fee conversion.
    /// @param oracle {PriceOracle} address.
    function setPriceOracle(address oracle) public override onlyOwner {
        super.setPriceOracle(oracle);
    }

    /// @notice Configure reference gas-price bounds for fee→gas conversion.
    /// @param minPriorityFeeWei_ Tip added to `block.basefee` on EIP-1559 chains.
    /// @param minGasPriceWei_ Floor for the reference gas price (must be non-zero).
    /// @param maxGasPriceWei_ Ceiling; zero disables the ceiling.
    function setGasPriceBounds(uint256 minPriorityFeeWei_, uint256 minGasPriceWei_, uint256 maxGasPriceWei_)
        public
        override
        onlyOwner
    {
        super.setGasPriceBounds(minPriorityFeeWei_, minGasPriceWei_, maxGasPriceWei_);
    }

    /// @notice Update minimum fee templates for local and remote legs.
    /// @param _local Local leg template.
    /// @param _remote Remote leg template.
    function updateMinFeeConfigs(FeeConfig memory _local, FeeConfig memory _remote) public override onlyOwner {
        super.updateMinFeeConfigs(_local, _remote);
    }

    /// @notice Set the respond/raise payload-weight cap (same units as {FeeConfig.maxMethodCallBytes}).
    function setMaxReplyMethodCallBytes(uint32 maxBytes) public override onlyOwner {
        super.setMaxReplyMethodCallBytes(maxBytes);
    }

    enum IncomingExecKind {
        Mine,
        Estimate
    }

    /// @inheritdoc InboxEstimateGas
    function _runEstimateIncomingExecution(
        Request storage incomingRequest,
        uint256 sourceChainId,
        uint256 maxUserGas
    ) internal override returns (uint256 gasUsed) {
        return _runIncomingExecution(incomingRequest, sourceChainId, IncomingExecKind.Estimate, maxUserGas);
    }

    /// @inheritdoc IInboxMiner
    /// @dev Restricted to the miner set — the estimate runs real target code and must not be a
    ///      permissionless probe surface. Body in {InboxEstimateGas._estimateExecutionGasForMiner}.
    function estimateExecutionGasForMiner(
        uint256 sourceChainId,
        MinedRequest calldata mined,
        uint256 maxUserGas
    ) external override onlyMiner {
        _estimateExecutionGasForMiner(sourceChainId, mined, maxUserGas);
    }

    /// @inheritdoc IInboxMiner
    function collectFees(address payable to) public override(FeeManagerStubBase, IInboxMiner) onlyOwner {
        super.collectFees(to);
    }

    /// @dev Executes one mined request: encode calldata, call target with `gas` from `targetFee`, record errors.
    function _executeIncomingRequest(Request storage incomingRequest, uint256 sourceChainId) internal {
        _runIncomingExecution(incomingRequest, sourceChainId, IncomingExecKind.Mine, 0);
    }

    /// @dev Shared mine / estimate execution path. Delivered execution failure is terminal
    ///      (`ErrorReceived` + system-error callback). Starved first mines revert {InsufficientMinerGas}.
    function _runIncomingExecution(
        Request storage incomingRequest,
        uint256 sourceChainId,
        IncomingExecKind kind,
        uint256 maxUserGas
    ) private returns (uint256 gasUsed) {
        _currentContext = ExecutionContext({
            remoteChainId: sourceChainId,
            remoteContract: incomingRequest.originalSender,
            requestId: incomingRequest.requestId
        });

        address targetContract = incomingRequest.targetContract;
        (bool encodedOk, bytes memory callData, bytes memory encodeErr) =
            _safeEncodeMethodCall(incomingRequest.methodCall);

        // Check after encode: an inner encode OOG returns false here; committing that as
        // ERROR_CODE_ENCODE_FAILED would ingest a starved mine. Revert the batch instead.
        uint256 targetGasBudget = _localRequestExecutionBudget(incomingRequest.targetFee);
        uint256 outerReserve =
            kind == IncomingExecKind.Estimate ? ESTIMATE_OUTER_RESERVE : POST_CALL_GAS_RESERVE;
        uint256 gasForCall = _computeUserCallGas(targetGasBudget, outerReserve, maxUserGas);

        if (kind == IncomingExecKind.Mine && gasForCall < targetGasBudget) {
            revert InsufficientMinerGas(incomingRequest.requestId, gasForCall, targetGasBudget);
        }

        if (!encodedOk) {
            bytes memory cappedEncodeErr = _recordEncodeError(incomingRequest.requestId, encodeErr);
            _sendSystemErrorCallback(incomingRequest, cappedEncodeErr);
            _clearExecutionContext();
            incomingRequest.executed = true;
            return 0;
        }

        uint256 gasBeforeSubcall = gasleft();
        (bool success, bytes memory returnData) =
            _callWithCappedReturnData(targetContract, gasForCall, callData);
        gasUsed = gasBeforeSubcall - gasleft();

        uint256 gasRemainingApprox = targetGasBudget > gasUsed ? targetGasBudget - gasUsed : 0;
        if (_shouldEmit()) {
            emit FeeExecutionSettled(incomingRequest.requestId, gasUsed, gasRemainingApprox);
        }

        if (!success) {
            bytes32 rid = incomingRequest.requestId;
            errors[rid] = Error({
                requestId: rid,
                errorCode: ERROR_CODE_EXECUTION_FAILED,
                errorMessage: returnData
            });
            if (_shouldEmit()) {
                emit ErrorReceived(rid, ERROR_CODE_EXECUTION_FAILED, returnData);
            }
            _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_EXECUTION_FAILED, returnData);
        }

        _clearExecutionContext();
        incomingRequest.executed = true;
    }

    function _clearExecutionContext() private {
        _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});
    }

    /// @dev Cap user subcall gas by prepaid budget, outer reserve, and optional maxUserGas (0 = uncapped).
    function _computeUserCallGas(uint256 targetGasBudget, uint256 outerReserve, uint256 maxUserGas)
        private
        view
        returns (uint256 gasForCall)
    {
        gasForCall = gasleft();
        if (gasForCall > outerReserve) {
            unchecked {
                gasForCall -= outerReserve;
            }
        }
        if (targetGasBudget < gasForCall) {
            gasForCall = targetGasBudget;
        }
        if (maxUserGas != 0 && maxUserGas < gasForCall) {
            gasForCall = maxUserGas;
        }
    }
}
