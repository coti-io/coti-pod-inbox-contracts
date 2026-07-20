// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title LargeRevertTarget
/// @notice Reverts with a large payload to exercise inbox returndata capping.
contract LargeRevertTarget {
    /// @notice Revert with `size` zero-bytes of returndata (raw revert, no Error(string)).
    function boom(uint256 size) external pure {
        assembly {
            let ptr := mload(0x40)
            // Expand memory without initializing (cheaper than a Solidity `new bytes`).
            mstore(0x40, add(ptr, size))
            revert(ptr, size)
        }
    }

    /// @notice No-op success path for a subsequent contiguous nonce.
    function ok() external pure returns (bool) {
        return true;
    }
}
