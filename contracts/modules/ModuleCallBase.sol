// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleCallBase
/// @notice Holds the InboxViews extension address.
/// @dev `inboxViews` sits at the end of Inbox storage (after MinerBase / ReentrancyGuard) so it
///      does not shift slots the facet reads. Forwarding lives in {InboxViewsStubBase}.
abstract contract ModuleCallBase {
    /// @notice Deployed {InboxViews} implementation (DELEGATECALL target). Apps still call Inbox.
    address public inboxViews;

    /// @notice Module address was zero when a call was required.
    error ModuleNotConfigured(address module);
}
