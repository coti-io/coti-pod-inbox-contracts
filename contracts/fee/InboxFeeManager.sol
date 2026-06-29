// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./PriceOracle.sol";

/// @title InboxFeeManager
/// @notice Validates cross-chain message fee budgets. Mixed into {InboxBase}.
/// @dev `msg.value` is converted to **gas units** using `tx.gasprice` (or {DEFAULT_GAS_PRICE} if zero). {Request.targetFee} and {Request.callerFee} store gas budgets, not wei. Oracle price ratio maps remote gas budgets when configured; otherwise 1:1.
abstract contract InboxFeeManager {
    /// @notice Template for minimum fees in **gas units** (not wei).
    /// @dev If `constantFee` is non-zero it is the minimum gas units. Else: `(data * gasPerByte + callbackExecutionGas + errorLength * gasPerByte) * bufferRatioX10000 / 10000`.
    struct FeeConfig {
        uint256 constantFee;
        uint256 gasPerByte;
        uint256 callbackExecutionGas;
        uint256 errorLength;
        uint256 bufferRatioX10000;
    }

    /// @notice Oracle used to convert gas budgets between local and remote fee tokens.
    PriceOracle public priceOracle;

    /// @notice Minimum template for the local (callback) leg.
    FeeConfig public localMinFeeConfig;

    /// @notice Minimum template for the remote execution leg.
    FeeConfig public remoteMinFeeConfig;

    /// @notice Fallback gas price (wei) when `tx.gasprice == 0`.
    uint256 public constant DEFAULT_GAS_PRICE = 2_000_000_000 wei;

    /// @dev Reserved execution gas units for error paths (documentation constant; enforcement is application-level).
    uint256 internal constant MIN_GAS_RESERVE_EXECUTION = 100_000;

    /// @notice Total native fee was zero.
    error TotalFeeTooLow(uint256 totalFee);
    /// @notice Callback fee slice was zero, exceeded total, or bought too few local callback gas units.
    error CallbackFeeTooLow(uint256 callbackFee);
    /// @notice Remote execution fee slice bought too few remote gas units.
    error TargetFeeTooLow(uint256 targetFee);
    /// @notice A non-constant fee template omitted a required field.
    error FeeConfigInvalid(FeeConfig feeConfig);
    /// @notice Fee collection recipient was zero.
    error CollectFeesZeroAddress();
    /// @notice {priceOracle} is unset.
    error OracleNotConfigured();
    /// @notice Oracle returned a zero USD price.
    error OraclePriceZero();

    /// @notice Send the contract's entire native balance to `to` (typically called by an owner-gated wrapper).
    /// @param to Recipient of accumulated message fees; must not be zero.
    function _collectFees(address payable to) internal {
        if (to == address(0)) revert CollectFeesZeroAddress();
        uint256 amount = address(this).balance;
        if (amount == 0) {
            return;
        }
        (bool ok,) = to.call{value: amount}("");
        require(ok, "Inbox: fee transfer failed");
    }

    /// @notice Execution gas budget available to an incoming target call after reserving error-return bytes.
    /// @param totalFee Stored target fee in gas units.
    /// @return budget Gas units forwarded to the target subcall.
    function _localRequestExecutionBudget(uint256 totalFee) internal view returns (uint256 budget) {
        FeeConfig memory localMin = localMinFeeConfig;
        if (localMin.constantFee > 0) {
            return totalFee;
        }
        uint256 errorBuffer = localMin.errorLength * localMin.gasPerByte;
        return totalFee > errorBuffer ? totalFee - errorBuffer : 0;
    }

    /// @notice Point the fee manager at a price oracle.
    /// @param priceOracleAddress Oracle contract address.
    function _setPriceOracle(address priceOracleAddress) internal {
        priceOracle = PriceOracle(priceOracleAddress);
        if (priceOracleAddress != address(0)) {
            _validatedOraclePrices();
        }
    }

    /// @dev Require a configured oracle with non-zero local and remote USD prices.
    function _validatedOraclePrices() internal view returns (uint256 localPrice, uint256 remotePrice) {
        if (address(priceOracle) == address(0)) {
            revert OracleNotConfigured();
        }
        (localPrice, remotePrice) = priceOracle.getPricesUSD();
        if (localPrice == 0 || remotePrice == 0) {
            revert OraclePriceZero();
        }
    }

    /// @notice Replace minimum fee templates (both must be valid if non-constant).
    /// @param _localMinFeeConfig Local leg template.
    /// @param _remoteMinFeeConfig Remote leg template.
    function _updateMinFeeConfigs(FeeConfig memory _localMinFeeConfig, FeeConfig memory _remoteMinFeeConfig) internal {
        if (
            _localMinFeeConfig.constantFee == 0
                && (
                    _localMinFeeConfig.gasPerByte == 0 || _localMinFeeConfig.callbackExecutionGas == 0
                        || _localMinFeeConfig.errorLength == 0 || _localMinFeeConfig.bufferRatioX10000 == 0
                )
        ) {
            revert FeeConfigInvalid(_localMinFeeConfig);
        }

        if (
            _remoteMinFeeConfig.constantFee == 0
                && (
                    _remoteMinFeeConfig.gasPerByte == 0 || _remoteMinFeeConfig.callbackExecutionGas == 0
                        || _remoteMinFeeConfig.errorLength == 0 || _remoteMinFeeConfig.bufferRatioX10000 == 0
                )
        ) {
            revert FeeConfigInvalid(_remoteMinFeeConfig);
        }
        localMinFeeConfig = _localMinFeeConfig;
        remoteMinFeeConfig = _remoteMinFeeConfig;
    }

    /// @notice Validate two-way payment and compute gas budgets for target and callback legs.
    /// @param dataSize Encoded method call size for template checks.
    /// @param totalFeeLocalWei Total `msg.value` (wei).
    /// @param callbackFeeLocalWei Wei reserved for the callback leg.
    /// @return targetGasRemoteUnits Gas units stored as {Request.targetFee} on the remote leg.
    /// @return callerGasLocalUnits Gas units stored as {Request.callerFee} for the callback.
    function validateAndPrepareTwoWayFees(uint256 dataSize, uint256 totalFeeLocalWei, uint256 callbackFeeLocalWei)
        internal
        view
        returns (uint256 targetGasRemoteUnits, uint256 callerGasLocalUnits)
    {
        if (totalFeeLocalWei == 0) {
            revert TotalFeeTooLow(totalFeeLocalWei);
        }
        if (callbackFeeLocalWei == 0) {
            revert CallbackFeeTooLow(callbackFeeLocalWei);
        }
        if (callbackFeeLocalWei > totalFeeLocalWei) {
            revert CallbackFeeTooLow(callbackFeeLocalWei);
        }

        (uint256 localPrice, uint256 remotePrice) = _validatedOraclePrices();
        FeeConfig memory localMin = localMinFeeConfig;
        FeeConfig memory remoteMin = remoteMinFeeConfig;
        uint256 gasPrice = tx.gasprice != 0 ? tx.gasprice : DEFAULT_GAS_PRICE;
        callerGasLocalUnits = callbackFeeLocalWei / gasPrice;
        uint256 remoteGasWei = totalFeeLocalWei - callbackFeeLocalWei;
        targetGasRemoteUnits = Math.mulDiv(remoteGasWei / gasPrice, localPrice, remotePrice);

        if (callerGasLocalUnits < expectedMinFee(dataSize, localMin)) {
            revert CallbackFeeTooLow(callerGasLocalUnits);
        }

        if (targetGasRemoteUnits < expectedMinFee(dataSize, remoteMin)) {
            revert TargetFeeTooLow(targetGasRemoteUnits);
        }
    }

    /// @notice Validate one-way payment and compute remote gas budget.
    /// @param dataSize Encoded method call size for template checks.
    /// @param totalFeeLocalWei Total `msg.value` (wei).
    /// @return targetGasRemoteUnits Gas units for {Request.targetFee}; {Request.callerFee} is zero.
    function validateAndPrepareOneWayFees(uint256 dataSize, uint256 totalFeeLocalWei)
        internal
        view
        returns (uint256 targetGasRemoteUnits)
    {
        if (totalFeeLocalWei == 0) {
            revert TotalFeeTooLow(totalFeeLocalWei);
        }
        (uint256 localPrice, uint256 remotePrice) = _validatedOraclePrices();
        FeeConfig memory remoteMin = remoteMinFeeConfig;
        uint256 gasPrice = tx.gasprice != 0 ? tx.gasprice : DEFAULT_GAS_PRICE;
        targetGasRemoteUnits = Math.mulDiv(totalFeeLocalWei / gasPrice, localPrice, remotePrice);
        if (targetGasRemoteUnits < expectedMinFee(dataSize, remoteMin)) {
            revert TargetFeeTooLow(targetGasRemoteUnits);
        }
    }

    /// @notice Minimum gas units from template (no wei conversion).
    /// @param dataSize Payload size for `gasPerByte` terms.
    /// @param feeConfig Template to apply.
    /// @return Gas units required before buffer.
    function expectedMinFee(uint256 dataSize, FeeConfig memory feeConfig) internal pure returns (uint256) {
        if (feeConfig.constantFee > 0) {
            return feeConfig.constantFee;
        }
        uint256 gasUnits = (dataSize * feeConfig.gasPerByte) + feeConfig.callbackExecutionGas
            + (feeConfig.errorLength * feeConfig.gasPerByte);
        return gasUnits * (10000 + feeConfig.bufferRatioX10000) / 10000;
    }

    /// @notice Off-chain / UI helper: rough local-token wei cost at `gasPrice`.
    /// @param remoteMethodCallSize Remote calldata size term.
    /// @param callBackMethodCallSize Callback calldata size term.
    /// @param remoteMethodExecutionGas Remote execution gas term.
    /// @param callBackMethodExecutionGas Callback execution gas term.
    /// @param gasPrice Wei per gas assumption.
    /// @return targetFeeLocalWei Local-token wei estimated for the remote execution leg.
    /// @return callerFeeLocalWei Local-token wei estimated for the callback leg.
    function calculateTwoWayFeeRequiredInLocalToken(
        uint256 remoteMethodCallSize,
        uint256 callBackMethodCallSize,
        uint256 remoteMethodExecutionGas,
        uint256 callBackMethodExecutionGas,
        uint256 gasPrice
    ) external view returns (uint256 targetFeeLocalWei, uint256 callerFeeLocalWei) {
        (uint256 localTokenPrice, uint256 remoteTokenPrice) = _validatedOraclePrices();
        FeeConfig memory remoteMin = remoteMinFeeConfig;
        FeeConfig memory localMin = localMinFeeConfig;
        uint256 targetGasRemoteUnits = expectedMinFee(remoteMethodCallSize, remoteMin) + remoteMethodExecutionGas;
        uint256 callerGasLocalUnits = expectedMinFee(callBackMethodCallSize, localMin) + callBackMethodExecutionGas;
        uint256 targetGasLocalUnits = Math.mulDiv(
            targetGasRemoteUnits,
            remoteTokenPrice,
            localTokenPrice,
            Math.Rounding.Ceil
        );
        targetFeeLocalWei = targetGasLocalUnits * gasPrice;
        callerFeeLocalWei = callerGasLocalUnits * gasPrice;
    }
}
