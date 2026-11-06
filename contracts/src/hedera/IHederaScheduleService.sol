// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Hedera Schedule Service at 0x16b. HIP-1215 generalized scheduled contract calls.
interface IHederaScheduleService {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes calldata callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool);
}

/// Response code 22 is SUCCESS on Hedera system contracts.
library HederaResponseCodes {
    int64 internal constant SUCCESS = 22;
}
