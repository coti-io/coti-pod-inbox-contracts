// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "../../../contracts/fee/FeeManagerStubBase.sol";

/// @title FeeTwoWayProbe
/// @notice Tiny Inbox-shaped host: same quote view + FeeManager DELEGATECALL as production send.
contract FeeTwoWayProbe is FeeManagerStubBase {
    constructor(address _feeManager) {
        if (_feeManager == address(0)) revert ModuleNotConfigured(_feeManager);
        feeManager = _feeManager;
        _ensureFeeDefaults();
    }

    function validateTwoWayFees(uint256 dataSize, uint256 callbackFeeLocalWei)
        external
        payable
        returns (uint256 targetGasRemoteUnits, uint256 callerGasLocalUnits)
    {
        return _validateAndPrepareTwoWayFees(dataSize, msg.value, callbackFeeLocalWei);
    }
}
