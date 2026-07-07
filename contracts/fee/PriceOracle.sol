// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title PriceOracle
/// @notice Cached USD oracle for inbox fee conversion.
/// @dev Inbox reads cache only; {PoDPriceOracle} adds live adapter reads for the portal.
contract PriceOracle is Ownable {
    /// @notice Price is stored with 18 decimals of precision.
    uint256 public constant PRICE_SCALE = 10 ** 18;

    /// @notice Minimum seconds between successful cache refreshes. Zero disables the time gate.
    uint256 public fetchInterval;

    /// @notice Timestamp of the last successful refresh or admin set.
    uint256 public lastFetchTimestamp;

    /// @notice Local execution-chain token whose USD price is cached for inbox fees.
    address public localToken;

    /// @notice Remote paired-chain token whose USD price is cached for inbox fees.
    address public remoteToken;

    /// @notice Cached USD price per inbox leg token (18 decimals per whole token).
    mapping(address => uint256) public cachedPriceUSD;

    /// @notice Address allowed to set manual prices (in addition to {refreshCache}).
    address public priceAdmin;

    /// @notice USD price of zero is not a valid peg.
    error ZeroUsdPrice();

    /// @notice Token address was zero.
    error ZeroToken();

    /// @notice Token is not a configured inbox leg.
    error UnknownToken(address token);

    /// @notice Caller is not the configured price admin.
    error NotPriceAdmin();

    /// @dev Reverts unless `msg.sender` is {priceAdmin}.
    modifier onlyPriceAdmin() {
        if (msg.sender != priceAdmin) {
            revert NotPriceAdmin();
        }
        _;
    }

    /// @param initialOwner {Ownable} owner; also initial {priceAdmin}.
    constructor(address initialOwner) Ownable(initialOwner) {
        priceAdmin = initialOwner;
    }

    /// @notice Configure inbox leg tokens (e.g. WETH local, COTI remote).
    function setInboxTokens(address localToken_, address remoteToken_) external onlyOwner {
        if (localToken_ == address(0) || remoteToken_ == address(0)) {
            revert ZeroToken();
        }
        localToken = localToken_;
        remoteToken = remoteToken_;
    }

    /// @notice Cached USD price for an inbox leg token.
    function getCachedPrice(address token) public view virtual returns (uint256 priceUsd) {
        if (token == localToken || token == remoteToken) {
            return cachedPriceUSD[token];
        }
        revert UnknownToken(token);
    }

    /// @notice Live USD price for `token` (defaults to cache on the base oracle).
    function getLivePrice(address token) public view virtual returns (uint256 priceUsd) {
        return getCachedPrice(token);
    }

    /// @notice Refresh both inbox cache legs when the interval gate allows.
    function refreshCache() public {
        _refreshInboxCache();
    }

    /// @notice Refresh one inbox leg when the interval gate allows.
    function refreshCache(address token) external {
        if (token != localToken && token != remoteToken) {
            revert UnknownToken(token);
        }
        if (!_fetchIntervalsElapsed()) {
            return;
        }
        lastFetchTimestamp = block.timestamp;
        cachedPriceUSD[token] = _pullCachedPrice(token);
        _afterRefreshCache();
    }

    function _refreshInboxCache() internal {
        if (!_fetchIntervalsElapsed()) {
            return;
        }
        lastFetchTimestamp = block.timestamp;
        if (localToken != address(0)) {
            cachedPriceUSD[localToken] = _pullCachedPrice(localToken);
        }
        if (remoteToken != address(0)) {
            cachedPriceUSD[remoteToken] = _pullCachedPrice(remoteToken);
        }
        _afterRefreshCache();
    }

    /// @notice Cached local and remote inbox leg prices.
    function getPricesUSD() external view returns (uint256 localPrice, uint256 remotePrice) {
        return (cachedPriceUSD[localToken], cachedPriceUSD[remoteToken]);
    }

    /// @notice Cached local leg price.
    function getLocalTokenPriceUSD() external view returns (uint256 price) {
        return cachedPriceUSD[localToken];
    }

    /// @notice Cached remote leg price.
    function getRemoteTokenPriceUSD() external view returns (uint256 price) {
        return cachedPriceUSD[remoteToken];
    }

    /// @notice Whether {refreshCache} would update storage at this block.
    function previewRefreshCache() external view returns (bool canRefresh) {
        return _fetchIntervalsElapsed();
    }

    /// @notice Minimum seconds between cache refreshes.
    function setFetchInterval(uint256 secondsBetweenFetches) external onlyOwner {
        fetchInterval = secondsBetweenFetches;
    }

    /// @notice Set the address allowed to set manual inbox prices.
    function setPriceAdmin(address admin) external onlyOwner {
        priceAdmin = admin;
    }

    /// @notice Manually set the cached local inbox price.
    function setLocalTokenPriceUSD(uint256 price) external onlyPriceAdmin {
        _setCachedPrice(localToken, price);
    }

    /// @notice Manually set the cached remote inbox price.
    function setRemoteTokenPriceUSD(uint256 price) external onlyPriceAdmin {
        _setCachedPrice(remoteToken, price);
    }

    /// @dev Hook after {refreshCache}; subclasses may refresh additional state.
    function _afterRefreshCache() internal virtual {}

    /// @dev Pull a fresh value for an inbox leg token.
    function _pullCachedPrice(address token) internal view virtual returns (uint256) {
        return cachedPriceUSD[token];
    }

    function _setCachedPrice(address token, uint256 price) internal {
        if (token == address(0)) {
            revert ZeroToken();
        }
        if (price == 0) {
            revert ZeroUsdPrice();
        }
        cachedPriceUSD[token] = price;
        lastFetchTimestamp = block.timestamp;
    }

    function _fetchIntervalsElapsed() internal view returns (bool) {
        if (fetchInterval != 0 && lastFetchTimestamp != 0 && block.timestamp - lastFetchTimestamp < fetchInterval) {
            return false;
        }
        return true;
    }
}
