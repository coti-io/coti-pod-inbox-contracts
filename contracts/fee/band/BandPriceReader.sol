// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BandFeedLib.sol";

/// @title BandPriceReader
/// @notice Band StdReference reads, isolated from Chainlink logic.
/// @dev Consumers pass a chain-wide `stdRef` plus per-price {Config}. Rate is base/quote × 1e18.
library BandPriceReader {
    /// @notice Per-price Band pair. `base` / `quote` are null-terminated symbols (e.g. "ETH", "USD").
    struct Config {
        bytes32 base;
        bytes32 quote;
    }

    /// @notice Read one Band pair when fresh.
    /// @param stdRef Band StdReference contract (zero disables reads).
    /// @param config Symbol pair for this price key.
    /// @param maxStaleness Max seconds since update (0 = ignore staleness).
    /// @return ok True when `price` is valid.
    /// @return price 18-decimal USD per whole base token.
    function tryReadPrice(address stdRef, Config memory config, uint256 maxStaleness)
        internal
        view
        returns (bool ok, uint256 price)
    {
        return BandFeedLib.tryReadPrice(stdRef, config.base, config.quote, maxStaleness);
    }

    /// @notice Read one Band pair with update timestamp.
    function tryReadPriceWithMeta(address stdRef, Config memory config, uint256 maxStaleness)
        internal
        view
        returns (bool ok, uint256 price, uint256 updatedAt)
    {
        return BandFeedLib.tryReadPriceWithMeta(stdRef, config.base, config.quote, maxStaleness);
    }

    /// @notice Bulk-read two base symbols against the same quote (gas optimization for portal fee validation).
    /// @return okA True when `priceA` is valid.
    /// @return priceA First leg price.
    /// @return okB True when `priceB` is valid.
    /// @return priceB Second leg price.
    function tryReadPriceBulk(
        address stdRef,
        Config memory configA,
        Config memory configB,
        uint256 maxStaleness
    ) internal view returns (bool okA, uint256 priceA, bool okB, uint256 priceB) {
        if (configA.quote != configB.quote) {
            return (false, 0, false, 0);
        }
        return BandFeedLib.tryReadPriceBulk(stdRef, configA.base, configB.base, configA.quote, maxStaleness);
    }

    /// @notice Whether both configs are eligible for {tryReadPriceBulk}.
    function canBulkRead(Config memory configA, Config memory configB) internal pure returns (bool) {
        return configA.base != bytes32(0) && configB.base != bytes32(0) && configA.quote == configB.quote;
    }
}
