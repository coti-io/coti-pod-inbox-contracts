// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleCallBase
/// @notice Holds the InboxViews extension address and DELEGATECALL helper.
/// @dev `inboxViews` is declared here so it sits at the end of Inbox storage (after
///      MinerBase / ReentrancyGuard) and does not shift slots the facet reads.
abstract contract ModuleCallBase {
    /// @notice Deployed {InboxViews} implementation (DELEGATECALL target). Apps still call Inbox.
    address public inboxViews;

    /// @notice Module address was zero when a call was required.
    error ModuleNotConfigured(address module);

    /// @dev DELEGATECALL into `module` with raw `msg.data`-shaped calldata; bubbles revert/return.
    function _delegateModule(address module, bytes calldata callData) internal returns (bytes memory) {
        if (module == address(0)) revert ModuleNotConfigured(module);
        (bool success, bytes memory returndata) = module.delegatecall(callData);
        if (!success) {
            _bubbleRevert(returndata);
        }
        return returndata;
    }

    function _bubbleRevert(bytes memory returndata) private pure {
        if (returndata.length == 0) revert();
        assembly ("memory-safe") {
            revert(add(returndata, 0x20), mload(returndata))
        }
    }
}
