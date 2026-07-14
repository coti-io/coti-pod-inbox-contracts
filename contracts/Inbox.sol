// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import "./InboxMiner.sol";

/// @title Inbox
/// @notice Production inbox: combines {InboxMiner} routing with {MinerBase} access control.
/// @dev The constructor takes no arguments so the creation bytecode is identical on every
/// chain, enabling a single deterministic address via CreateX `deployCreate3AndInit`.
/// `chainId` and the real owner are configured once through {init}.
/// Split deploy-then-initialize is unsafe; use CreateX `deployCreate3AndInit` or an equivalent atomic path.
contract Inbox is InboxMiner, Initializable {
    /// @dev `Ownable` needs a non-zero initial owner; the contract briefly owns itself until
    /// {init} calls `_transferOwnership`, so bytecode still has no external-address dependency.
    constructor() InboxMiner() Ownable(address(this)) {}

    /// @notice One-time initializer: sets `chainId` and the owner.
    /// @dev Intended to run atomically inside CreateX `deployCreate3AndInit` (no front-run window).
    /// @param initialOwner Address that becomes the {Ownable} owner (typically the deployer EOA).
    /// @param _chainId This chain's ID; pass `0` to use `block.chainid`.
    function init(address initialOwner, uint256 _chainId) external initializer {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(initialOwner);
        }
        _initInboxBase(_chainId);
        _transferOwnership(initialOwner);
    }
}
