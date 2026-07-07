// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "./AggregatorV3Interface.sol";

/// @title ChainlinkFeedLib
/// @notice Read Chainlink Data Feeds and normalize answers to 18-decimal USD per whole token.
/// @dev Never reverts: stale, incomplete rounds, non-positive answers, and failed calls return `(false, 0)`.
library ChainlinkFeedLib {
    /// @dev Scale matching {PriceOracle.PRICE_SCALE}.
    uint256 internal constant PRICE_SCALE = 10 ** 18;

    /// @notice Read a feed when fresh.
    /// @param feed Chainlink aggregator (`address(0)` disables reads).
    /// @param maxStaleness Max seconds since `updatedAt` (`0` = no age check).
    function tryReadPrice(address feed, uint256 maxStaleness) internal view returns (bool ok, uint256 price) {
        if (feed == address(0) || feed.code.length == 0) {
            return (false, 0);
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80 answeredInRound
        ) {
            if (answer <= 0 || answeredInRound < roundId) {
                return (false, 0);
            }
            if (maxStaleness != 0 && updatedAt + maxStaleness < block.timestamp) {
                return (false, 0);
            }
            uint8 decimals = AggregatorV3Interface(feed).decimals();
            return (true, _normalizeTo18(uint256(answer), decimals));
        } catch {
            return (false, 0);
        }
    }

    /// @notice Read a feed when fresh, including `updatedAt`.
    function tryReadPriceWithMeta(address feed, uint256 maxStaleness)
        internal
        view
        returns (bool ok, uint256 price, uint256 updatedAt)
    {
        if (feed == address(0) || feed.code.length == 0) {
            return (false, 0, 0);
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 feedUpdatedAt,
            uint80 answeredInRound
        ) {
            updatedAt = feedUpdatedAt;
            if (answer <= 0 || answeredInRound < roundId) {
                return (false, 0, updatedAt);
            }
            if (maxStaleness != 0 && updatedAt + maxStaleness < block.timestamp) {
                return (false, 0, updatedAt);
            }
            uint8 decimals = AggregatorV3Interface(feed).decimals();
            return (true, _normalizeTo18(uint256(answer), decimals), updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev Convert feed answer to 18 decimals (USD per whole token).
    function _normalizeTo18(uint256 answer, uint8 decimals) private pure returns (uint256) {
        if (decimals == 18) {
            return answer;
        }
        if (decimals < 18) {
            return answer * (10 ** (18 - decimals));
        }
        return Math.mulDiv(answer, PRICE_SCALE, 10 ** decimals);
    }
}
