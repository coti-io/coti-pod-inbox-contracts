// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

import "./ModuleCallBase.sol";

/// @title InboxViewsStubBase
/// @notice Explorer-visible stubs for {InboxViews} — DELEGATECALL + returndata forward.
/// @dev Not `view`/`pure`: Solidity forbids delegatecall in view (high-level and assembly).
///      {staticcall} to the facet address would read the facet's storage, not Inbox's.
///      Stubs only forward returndata (no abi.decode) to keep create bytecode small.
abstract contract InboxViewsStubBase is ModuleCallBase {
    /// @dev DELEGATECALL {inboxViews} with `msg.data` and return/revert with its returndata.
    function _forwardToViews() internal {
        address ext = inboxViews;
        if (ext == address(0)) revert ModuleNotConfigured(ext);
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function getOutboxError(bytes32) external returns (uint256, bytes memory) {
        _forwardToViews();
    }

    function getInboxResponse(bytes32) external returns (bytes memory) {
        _forwardToViews();
    }

    function getRequests(uint256, uint256, uint256) external returns (IInbox.Request[] memory) {
        _forwardToViews();
    }

    function getRequestsLen(uint256) external returns (uint256) {
        _forwardToViews();
    }

    function getRequest(bytes32) external returns (IInbox.Request memory) {
        _forwardToViews();
    }

    function getIncomingRequest(bytes32) external returns (IInbox.Request memory) {
        _forwardToViews();
    }

    function getRequestId(uint256, uint256, uint256) external returns (bytes32) {
        _forwardToViews();
    }

    function unpackRequestId(bytes32) external returns (uint256, uint256, uint256) {
        _forwardToViews();
    }

    function isMiner(address) external returns (bool) {
        _forwardToViews();
    }
}
