// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./InboxBase.sol";

/// @title InboxEstimateGas
/// @notice Estimate-mode flags/hooks on {InboxBase}. Public estimate entry lives on {InboxViews}.
/// @dev Sits between {InboxBase} and {InboxMiner}. While estimating, reply creates are tagged and their
///      payload weights accumulate for {IInboxMiner.ExecutionGasEstimate}. {InboxMiner} supplies
///      {_runEstimateIncomingExecution} / {runEstimateIncomingExecution}.
abstract contract InboxEstimateGas is InboxBase {
    bool private _estimating;
    /// @dev 0 = none, 1 = respond outbound, 2 = raise / system-error outbound.
    uint8 private _estimateReplyKind;
    uint256 private _estimateResponseBytes;
    uint256 private _estimateErrorBytes;

    uint8 private constant _REPLY_NONE = 0;
    uint8 private constant _REPLY_RESPONSE = 1;
    uint8 private constant _REPLY_ERROR = 2;

    function _isEstimating() internal view override returns (bool) {
        return _estimating;
    }

    /// @dev True when events / durable log side-effects should run (not during estimate).
    function _shouldEmit() internal view override returns (bool) {
        return !_estimating;
    }

    function _enterEstimateMode() internal {
        _estimating = true;
        _estimateReplyKind = _REPLY_NONE;
        _estimateResponseBytes = 0;
        _estimateErrorBytes = 0;
    }

    function _exitEstimateMode() internal {
        _estimating = false;
    }

    function _estimateResponseDataSize() internal view returns (uint256) {
        return _estimateResponseBytes;
    }

    function _estimateErrorDataSize() internal view returns (uint256) {
        return _estimateErrorBytes;
    }

    /// @dev Tag the next outbound create as respond (`isError=false`) or raise/system-error.
    function _tagEstimateOutboundReply(bool isError) internal override {
        if (!_estimating) {
            return;
        }
        _estimateReplyKind = isError ? _REPLY_ERROR : _REPLY_RESPONSE;
    }

    /// @dev If a reply was tagged, add its payload weight to the matching accumulator.
    function _accumulateEstimateOutboundIfTagged(uint256 weight) internal override {
        if (!_estimating || _estimateReplyKind == _REPLY_NONE) {
            return;
        }
        if (_estimateReplyKind == _REPLY_RESPONSE) {
            _estimateResponseBytes += weight;
        } else {
            _estimateErrorBytes += weight;
        }
        _estimateReplyKind = _REPLY_NONE;
    }

    /// @dev Shared mine/estimate/retry path implemented by {InboxMiner}.
    function _runEstimateIncomingExecution(
        IInbox.Request storage incomingRequest,
        uint256 sourceChainId,
        uint256 maxUserGas
    ) internal virtual returns (uint256 gasUsed);
}
