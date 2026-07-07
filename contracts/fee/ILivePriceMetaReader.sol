// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILivePriceMetaReader
/// @notice Metadata extension for {IPodPriceOracle} feed adapters.
interface ILivePriceMetaReader {
    /// @return priceUsd 18-decimal USD per whole token (`0` when unavailable).
    /// @return updatedAt Feed update timestamp (seconds).
    function readPriceWithMeta(address token) external view returns (uint256 priceUsd, uint256 updatedAt);
}
