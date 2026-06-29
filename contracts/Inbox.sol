// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./InboxMiner.sol";
import "./MinerBase.sol";

/// @title Inbox
/// @notice Production inbox: combines {InboxMiner} routing with {MinerBase} access control.
/// @dev The constructor takes no arguments so the creation bytecode is identical on every
/// chain, enabling a single deterministic address via CreateX `deployCreate3AndInit`.
/// `chainId` and the real owner are configured once through {init}.
contract Inbox is InboxMiner {
    constructor() InboxMiner() {}

    /// @notice One-time initializer: sets `chainId` and the owner.
    /// @dev Intended to run atomically inside CreateX `deployCreate3AndInit` (no front-run window),
    /// but is safe to call directly once for non-CreateX deployments. Reverts on second call.
    /// @param initialOwner Address that becomes the {Ownable} owner (typically the deployer EOA).
    /// @param _chainId This chain's ID; pass `0` to use `block.chainid`.
    function init(address initialOwner, uint256 _chainId) external {
        _initInboxBase(_chainId);
        _transferOwnership(initialOwner);
    }
}
