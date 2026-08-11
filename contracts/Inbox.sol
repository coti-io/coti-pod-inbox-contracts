// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import "./InboxMiner.sol";
import "./modules/ModuleCallBase.sol";

/// @title Inbox
/// @notice Production inbox: combines {InboxMiner} routing with {MinerBase} access control.
/// @dev The constructor takes no arguments so the creation bytecode is identical on every
/// chain, enabling a single deterministic address via CreateX `deployCreate3AndInit`.
/// `chainId` and the real owner are configured once through {init}.
/// Split deploy-then-initialize is unsafe; use CreateX `deployCreate3AndInit` or an equivalent atomic path.
/// Do **not** call `_disableInitializers()` here: this contract *is* the live instance (no separate
/// implementation), and `{init}` must remain callable exactly once via the atomic CreateX path.
///
/// Read/estimate APIs (`getRequest`, `isMiner`, `estimateExecutionGasForMiner`, …) live on {InboxViews}
/// and are reached via {fallback} DELEGATECALL. Clients call this address with an Inbox+InboxViews ABI.
contract Inbox is InboxMiner, Initializable, ModuleCallBase {
    /// @dev Placeholder owner until {init}; fixed address keeps creation bytecode identical on every chain.
    ///      After atomic init, owner must be the intended admin (deploy scripts assert `owner() != address(1)`).
    constructor() Ownable(address(1)) {}

    /// @notice One-time initializer: sets `chainId`, owner, MPC helper, and {InboxViews} extension.
    /// @dev Intended to run atomically inside CreateX `deployCreate3AndInit` (no front-run window).
    /// @param initialOwner Address that becomes the {Ownable} owner (typically the deployer EOA).
    /// @param _chainId This chain's ID; pass `0` to use `block.chainid`.
    /// @param _mpcAbiReEncode COTI {MpcAbiReEncode} address, or `address(0)` on non-MPC chains.
    /// @param _inboxViews Deployed {InboxViews} (required; DELEGATECALL target for views/estimate).
    function init(address initialOwner, uint256 _chainId, address _mpcAbiReEncode, address _inboxViews)
        external
        initializer
    {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(initialOwner);
        }
        if (_inboxViews == address(0)) {
            revert ModuleNotConfigured(_inboxViews);
        }
        inboxViews = _inboxViews;
        _initInboxBase(_chainId, _mpcAbiReEncode);
        _transferOwnership(initialOwner);
    }

    /// @notice Ownership cannot be renounced (inbox admin must remain reachable).
    function renounceOwnership() public pure override {
        revert();
    }

    /// @notice See {IInboxMiner}.
    /// @dev Thin stub: DELEGATECALL into {InboxViews} (always reverts with ExecutionGasEstimate).
    function estimateExecutionGasForMiner(uint256, IInboxMiner.MinedRequest calldata, uint256)
        external
        override
    {
        _delegateModule(inboxViews, msg.data);
    }

    /// @dev Diamond-style router: unknown selectors DELEGATECALL into {inboxViews}.
    fallback() external payable {
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

    /// @dev Reject plain ETH transfers; payable entrypoints are explicit send APIs.
    receive() external payable {
        revert();
    }
}
