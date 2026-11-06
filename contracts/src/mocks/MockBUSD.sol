// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Plain ERC-20 stand-in for bUSD. Frozen accounts make `transfer` return false
/// so the escrow can prove a failed payout leaves state unchanged.
contract MockBUSD {
    string public name = "Byline USD";
    string public symbol = "bUSD";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFrozen(address account, bool value) external {
        frozen[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) return false;
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        if (frozen[from] || frozen[to]) return false;
        if (balanceOf[from] < amount) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
