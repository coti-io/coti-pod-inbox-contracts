// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title PriceOracle
/// @notice Base oracle: cached 18-decimal USD-stable prices per wei, optional time-based pull interval, and admin overrides.
/// @dev Subclasses override {fetchLocalTokenPriceUSD} / {fetchRemoteTokenPriceUSD} to refresh from feeds.
contract PriceOracle is Ownable {
    /// @notice Price is stored with 18 decimals of precision
    uint256 public constant PRICE_SCALE = 10 ** 18;

    /// @notice Minimum seconds between successful pulls in {fetchPrices}. Zero disables the time gate.
    uint256 public fetchInterval;

    /// @notice Timestamp of the last successful pull or admin set.
    uint256 public lastFetchTimestamp;

    /// @notice Cached local execution token price.
    uint256 public localTokenPriceUSD;

    /// @notice Cached remote execution token price.
    uint256 public remoteTokenPriceUSD;

    /// @notice Address allowed to set prices directly (in addition to {fetchPrices}).
    address public priceAdmin;

    /// @notice Caller is not the configured price admin.
    error NotPriceAdmin();

    /// @dev Reverts unless `msg.sender` is {priceAdmin}.
    modifier onlyPriceAdmin() {
        if (msg.sender != priceAdmin) {
            revert NotPriceAdmin();
        }
        _;
    }

    /// @param initialOwner {Ownable} owner; also initial {priceAdmin} so prices can be set without a separate admin tx.
    constructor(address initialOwner) Ownable(initialOwner) {
        priceAdmin = initialOwner;
    }

    /// @notice Refresh cached prices when the time gate allows.
    /// @dev Interval checks are cheap storage reads only. Inbox fee paths use {getLocalTokenPriceUSD}/{getRemoteTokenPriceUSD} only (no pull). Use {previewFetchPrices} with `estimateGas` when budgeting `fetchPrices`.
    function fetchPrices() external {
        if (!_fetchIntervalsElapsed()) {
            return;
        }

        lastFetchTimestamp = block.timestamp;
        localTokenPriceUSD = fetchLocalTokenPriceUSD();
        remoteTokenPriceUSD = fetchRemoteTokenPriceUSD();
    }

    /// @notice Minimum seconds between pulls.
    /// @param secondsBetweenFetches New interval (0 = off).
    function setFetchInterval(uint256 secondsBetweenFetches) external onlyOwner {
        fetchInterval = secondsBetweenFetches;
    }

    /// @notice Set the address allowed to call {setLocalTokenPriceUSD} / {setRemoteTokenPriceUSD}.
    /// @param admin Price admin address.
    function setPriceAdmin(address admin) external onlyOwner {
        priceAdmin = admin;
    }

    /// @notice Manually set the local token price (also updates {lastFetchTimestamp}).
    /// @param price with 18 decimals of precision
    function setLocalTokenPriceUSD(uint256 price) external onlyPriceAdmin {
        localTokenPriceUSD = price;
        lastFetchTimestamp = block.timestamp;
    }

    /// @notice Manually set the remote token price (also updates {lastFetchTimestamp}).
    /// @param price with 18 decimals of precision
    function setRemoteTokenPriceUSD(uint256 price) external onlyPriceAdmin {
        remoteTokenPriceUSD = price;
        lastFetchTimestamp = block.timestamp;
    }

    /// @notice Cached local token price (read-only for fee logic).
    /// @return price with 18 decimals of precision
    function getLocalTokenPriceUSD() external view returns (uint256 price) {
        return localTokenPriceUSD;
    }

    /// @notice Cached remote token price (read-only for fee logic).
    /// @return price with 18 decimals of precision
    function getRemoteTokenPriceUSD() external view returns (uint256 price) {
        return remoteTokenPriceUSD;
    }

    /// @notice Get the local and remote token prices in USD.
    /// @return localPrice Local token price in USD.
    /// @return remotePrice Remote token price in USD.
    function getPricesUSD() external view returns (uint256 localPrice, uint256 remotePrice) {
        return (localTokenPriceUSD, remoteTokenPriceUSD);
    }

    /// @notice Whether {fetchPrices} would update storage at this block.
    /// @return canFetch True if the time gate passes.
    function previewFetchPrices() external view returns (bool canFetch) {
        return _fetchIntervalsElapsed();
    }

    /// @dev True if enough time has passed since {lastFetchTimestamp} for a pull.
    function _fetchIntervalsElapsed() internal view returns (bool) {
        if (fetchInterval != 0 && lastFetchTimestamp != 0 && block.timestamp - lastFetchTimestamp < fetchInterval) {
            return false;
        }
        return true;
    }

    /// @dev Override to pull local token price; default returns the cache.
    function fetchLocalTokenPriceUSD() internal view virtual returns (uint256) {
        return localTokenPriceUSD;
    }

    /// @dev Override to pull remote token price; default returns the cache.
    function fetchRemoteTokenPriceUSD() internal view virtual returns (uint256) {
        return remoteTokenPriceUSD;
    }
}
