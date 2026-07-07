// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ChainlinkFeedLib.sol";

/// @title ChainlinkPriceReader
/// @notice Chainlink Data Feed reads, isolated from Band logic.
/// @dev Answers are normalized to 18-decimal USD per whole token via {ChainlinkFeedLib}.
library ChainlinkPriceReader {
    /// @notice Per-price Chainlink aggregator configuration.
    struct Config {
        address aggregator;
    }

    /// @notice Read one Chainlink feed when fresh.
    /// @param config Aggregator address (zero disables reads).
    /// @param maxStaleness Max seconds since `updatedAt` (0 = ignore staleness).
    /// @return ok True when `price` is valid.
    /// @return price 18-decimal USD per whole token.
    function tryReadPrice(Config memory config, uint256 maxStaleness)
        internal
        view
        returns (bool ok, uint256 price)
    {
        return ChainlinkFeedLib.tryReadPrice(config.aggregator, maxStaleness);
    }

    /// @notice Read one Chainlink feed when fresh, including `updatedAt`.
    function tryReadPriceWithMeta(Config memory config, uint256 maxStaleness)
        internal
        view
        returns (bool ok, uint256 price, uint256 updatedAt)
    {
        return ChainlinkFeedLib.tryReadPriceWithMeta(config.aggregator, maxStaleness);
    }
}
