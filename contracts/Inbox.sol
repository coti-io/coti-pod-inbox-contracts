// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./InboxMiner.sol";

/// @title Inbox
/// @notice Production inbox: combines {InboxMiner} routing with {MinerBase} access control.
/// @dev The constructor takes no arguments so the creation bytecode is identical on every
/// chain, enabling a single deterministic address via CreateX `deployCreate3AndInit`.
/// `chainId` and the real owner are configured once through {init}.
/// Split deploy-then-initialize is unsafe; use CreateX `deployCreate3AndInit` or an equivalent atomic path.
/// One-shot init is `{_initInboxBase}`'s `_initialized` plus `{_initDeployer}` — not OZ {Initializable}
/// (saves create-size; this contract *is* the live instance, not a proxy implementation).
contract Inbox is InboxMiner {
    /// @dev Canonical CreateX. CREATE3 constructor `msg.sender` is the Create3 proxy;
    ///      `deployCreate3AndInit` then calls {init} from this address.
    address private constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

    /// @dev `msg.sender` at construction (Create3 proxy under CreateX, or the EOA in tests).
    address private _initDeployer;

    /// @dev Placeholder owner until {init}; fixed address keeps creation bytecode identical on every chain.
    ///      After atomic init, owner must be the intended admin (deploy scripts assert `owner() != address(1)`).
    constructor() Ownable(address(1)) {
        _initDeployer = msg.sender;
    }

    /// @notice One-time initializer: sets `chainId`, owner, and DELEGATECALL helpers.
    /// @dev Intended to run atomically inside CreateX `deployCreate3AndInit` (no front-run window).
    ///      Caller must be the constructor deployer so a non-atomic init cannot be claimed by a stranger.
    ///      Helpers are not rotatable after this call; a module fix is an Inbox redeploy.
    /// @param initialOwner Address that becomes the {Ownable} owner (typically the deployer EOA).
    /// @param _chainId This chain's ID; pass `0` to use `block.chainid`.
    /// @param _mpcAbiReEncode COTI {MpcAbiReEncode} address, or `address(0)` on non-MPC chains.
    /// @param _feeManager Deployed {FeeManager} (required on every chain).
    function init(address initialOwner, uint256 _chainId, address _mpcAbiReEncode, address _feeManager) external {
        // Bare revert keeps create bytecode under the Spurious Dragon limit.
        if (msg.sender != _initDeployer && msg.sender != CREATEX) revert();
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(initialOwner);
        }
        _initInboxBase(_chainId, _mpcAbiReEncode, _feeManager);
        _transferOwnership(initialOwner);
    }

    /// @notice Ownership cannot be renounced (inbox admin must remain reachable).
    function renounceOwnership() public pure override {
        revert();
    }
}
