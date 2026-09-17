// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleCallBase
/// @notice Holds the FeeManager address and a DELEGATECALL helper (Inbox storage context).
/// @dev Fee-specific code passes {feeManager} into {_delegateModule}. No STATICCALL helper:
///      STATICCALL would read the module's empty storage, not Inbox ERC-7201.
abstract contract ModuleCallBase {
    /// @notice Deployed {FeeManager} implementation (DELEGATECALL target). Apps still call Inbox.
    /// @dev Immutable after Inbox {init}; rotating it requires redeploying the Inbox.
    address public feeManager;

    /// @notice Module address was zero when a call was required.
    error ModuleNotConfigured(address module);
    /// @notice Module address has no code (DELEGATECALL would silently no-op).
    error ModuleHasNoCode();

    /// @dev DELEGATECALL into `module` with `callData`; bubbles revert data. `address(this)` stays the Inbox.
    function _delegateModule(address module, bytes memory callData) internal returns (bytes memory) {
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
