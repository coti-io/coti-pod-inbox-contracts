// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";

import "./InboxEstimateGas.sol";
import "./MinerBase.sol";
import "./lib/MinerRejectLib.sol";

/// @title InboxViews
/// @notice Read / estimate APIs for Inbox via DELEGATECALL (Diamond-style facet).
/// @dev Storage layout matches Inbox through MinerBase (FeeManager → InboxBase → EstimateGas →
///      Ownable → Ownable2Step → MinerBase). Never CALL this contract for live state — only
///      DELEGATECALL from Inbox so `address(this)` is the Inbox.
interface IInboxEstimateHook {
    function runEstimateIncomingExecution(bytes32 requestId, uint256 sourceChainId, uint256 maxUserGas)
        external
        returns (uint256 gasUsed);
}

contract InboxViews is InboxEstimateGas, MinerBase {
    /// @dev Placeholder owner; facet is never used as Ownable authority (Inbox owns state).
    constructor() Ownable(address(1)) {}

    // ─── Views (formerly InboxBase) ──────────────────────────────────────────

    /// @notice See {IInbox}.
    function getOutboxError(bytes32 requestId) external view returns (uint256 code, bytes memory data) {
        IInbox.Error memory err = errors[requestId];
        if (err.requestId == bytes32(0)) revert ErrorNotFound();
        return (err.errorCode, err.errorMessage);
    }

    /// @notice See {IInbox}.
    function getInboxResponse(bytes32 requestId) external view returns (bytes memory) {
        IInbox.Response memory response = inboxResponses[requestId];
        if (response.responseRequestId == bytes32(0)) revert ResponseNotFound();
        return response.response;
    }

    /// @notice See {IInbox}.
    function getRequests(uint256 targetChainId, uint256 from, uint256 len)
        external
        view
        returns (IInbox.Request[] memory)
    {
        if (len == 0) {
            return new IInbox.Request[](0);
        }

        uint256 total = _requestNonce[targetChainId];
        if (total == 0 || from >= total) {
            return new IInbox.Request[](0);
        }

        uint256 remaining = total - from;
        uint256 actualLen = len > remaining ? remaining : len;
        IInbox.Request[] memory result = new IInbox.Request[](actualLen);
        uint256 localChainId = chainId;

        for (uint256 i = 0; i < actualLen;) {
            uint256 nonce = from + i + 1;
            bytes32 requestId = _packRequestId(localChainId, targetChainId, nonce);
            result[i] = requests[requestId];
            unchecked {
                ++i;
            }
        }

        return result;
    }

    /// @notice See {IInbox}.
    function getRequestsLen(uint256 targetChainId) external view returns (uint256) {
        return _requestNonce[targetChainId];
    }

    /// @notice See {IInbox}.
    function getRequest(bytes32 requestId) external view returns (IInbox.Request memory) {
        return requests[requestId];
    }

    /// @notice See {IInbox}.
    function getIncomingRequest(bytes32 requestId) external view returns (IInbox.Request memory) {
        return incomingRequests[requestId];
    }

    /// @notice See {IInbox}.
    function getRequestId(uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
        external
        pure
        returns (bytes32)
    {
        return _packRequestId(sourceChainId, targetChainId, nonce);
    }

    /// @notice See {IInbox}.
    function unpackRequestId(bytes32 requestId)
        external
        pure
        returns (uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
    {
        return _unpackRequestId(requestId);
    }

    /// @notice Whether `miner` is registered (reads MinerBase `_miners` on Inbox storage).
    function isMiner(address miner) external view returns (bool) {
        return _isMiner(miner);
    }

    // ─── Estimate (formerly InboxMiner / InboxEstimateGas) ───────────────────

    /// @notice See {IInboxMiner}.
    /// @dev Always reverts with {IInboxMiner.ExecutionGasEstimate}. Execution runs on Inbox via
    ///      {IInboxEstimateHook.runEstimateIncomingExecution} (external self-call).
    function estimateExecutionGasForMiner(
        uint256 sourceChainId,
        IInboxMiner.MinedRequest calldata mined,
        uint256 maxUserGas
    ) external {
        if (_isEstimating() || _currentContext.requestId != bytes32(0)) {
            revert IInboxMiner.EstimateBusy();
        }
        if (sourceChainId == chainId) {
            revert IInboxMiner.SourceChainIsThisChain(chainId);
        }

        bytes32 requestId = mined.requestId;
        (uint256 minedChainId, uint256 minedTargetChainId,) = _unpackRequestId(requestId);
        if (minedChainId != sourceChainId) {
            revert IInboxMiner.RequestSourceChainMismatch(requestId, sourceChainId, minedChainId);
        }
        if (minedTargetChainId != chainId) {
            revert IInboxMiner.RequestTargetChainMismatch(requestId, chainId, minedTargetChainId);
        }
        if (mined.sourceContract == address(0)) revert InvalidSourceContract();
        if (mined.targetContract == address(0)) revert InvalidTargetContract();

        (bool isReject,,) = MinerRejectLib.parse(mined.methodCall);
        if (isReject) {
            revert IInboxMiner.EstimateRejectNotExecutable();
        }

        FeeConfig memory localCaps = localMinFeeConfig;
        uint256 weight = MinerRejectLib.structuralSize(mined.methodCall);
        if (weight > localCaps.maxMethodCallBytes) {
            revert MethodCallTooLarge(weight, localCaps.maxMethodCallBytes);
        }
        if (mined.targetFee > localCaps.maxExecutionGas) {
            revert FeeGasTooHigh(mined.targetFee, localCaps.maxExecutionGas);
        }
        if (mined.callerFee > localCaps.maxExecutionGas) {
            revert FeeGasTooHigh(mined.callerFee, localCaps.maxExecutionGas);
        }

        _enterEstimateMode();

        incomingRequests[requestId] = IInbox.Request({
            requestId: requestId,
            targetChainId: sourceChainId,
            targetContract: mined.targetContract,
            methodCall: mined.methodCall,
            callerContract: mined.sourceContract,
            originalSender: mined.sourceContract,
            timestamp: uint64(block.timestamp),
            callbackSelector: mined.callbackSelector,
            errorSelector: mined.errorSelector,
            isTwoWay: mined.isTwoWay,
            executed: false,
            sourceRequestId: mined.sourceRequestId,
            targetFee: mined.targetFee,
            callerFee: mined.callerFee
        });

        uint256 gasUsed = _runEstimateIncomingExecution(incomingRequests[requestId], sourceChainId, maxUserGas);

        uint256 responseDataSize = _estimateResponseDataSize();
        uint256 errorDataSize = _estimateErrorDataSize();
        _exitEstimateMode();
        revert IInboxMiner.ExecutionGasEstimate(gasUsed, responseDataSize, errorDataSize);
    }

    /// @dev External self-call into Inbox so mine/estimate execution bytecode stays on Inbox.
    function _runEstimateIncomingExecution(
        IInbox.Request storage incomingRequest,
        uint256 sourceChainId,
        uint256 maxUserGas
    ) internal override returns (uint256 gasUsed) {
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeCall(
                IInboxEstimateHook.runEstimateIncomingExecution,
                (incomingRequest.requestId, sourceChainId, maxUserGas)
            )
        );
        if (!ok) {
            if (ret.length == 0) revert();
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return abi.decode(ret, (uint256));
    }
}
