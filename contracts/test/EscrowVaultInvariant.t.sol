// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {EscrowVault} from "../src/EscrowVault.sol";
import {MockBUSD} from "../src/mocks/MockBUSD.sol";

/// Drives the vault the way a keeper, a lab, and a worker would.
/// Ghost state records whether a task has already been terminal.
contract EscrowHandler is StdUtils {
    Vm private constant cheats = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    EscrowVault public vault;
    MockBUSD public busd;
    address public client;
    address public worker;
    address public oracle;
    address public reviewer;
    address public relayer;

    bytes32[] public batchIds;
    uint256 public nonce;
    uint256 public terminalViolations;
    mapping(uint256 => bool) public seenTerminal;

    constructor(
        EscrowVault vault_,
        MockBUSD busd_,
        address client_,
        address worker_,
        address oracle_,
        address reviewer_,
        address relayer_
    ) {
        vault = vault_;
        busd = busd_;
        client = client_;
        worker = worker_;
        oracle = oracle_;
        reviewer = reviewer_;
        relayer = relayer_;
    }

    function fund(uint64 rawPay, uint32 rawCount) external {
        uint64 pay = uint64(bound(rawPay, 1, 500_000_000));
        uint32 count = uint32(bound(rawCount, 1, 4));
        bytes32 id = keccak256(abi.encode("inv-batch", nonce++, pay, count));
        uint256 total = (uint256(pay) + (uint256(pay) * 300 / 10_000)) * count;
        busd.mint(client, total);
        cheats.startPrank(client);
        busd.approve(address(vault), total);
        try vault.fundBatch(id, count, pay, 120, 120, 120) {
            batchIds.push(id);
        } catch {}
        cheats.stopPrank();
        _audit();
    }

    function claim(uint256 rawIndex) external {
        if (batchIds.length == 0) return;
        bytes32 id = batchIds[bound(rawIndex, 0, batchIds.length - 1)];
        (, uint64 pay,,,,,,) = vault.batches(id);
        if (pay > vault.hitlThreshold()) {
            cheats.prank(relayer);
            try vault.claimFor(id, worker) returns (uint256) {} catch {}
        } else {
            cheats.prank(worker);
            try vault.claim(id) returns (uint256) {} catch {}
        }
        _audit();
    }

    function submitWork(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        (, EscrowVault.TaskState state,,,,,,,,,,,,) = vault.tasks(taskId);
        bytes32 hash = keccak256(abi.encode("work", taskId, nonce++));
        cheats.prank(worker);
        if (state == EscrowVault.TaskState.Revising) {
            try vault.resubmit(taskId, hash) {} catch {}
        } else {
            try vault.submit(taskId, hash) {} catch {}
        }
        _audit();
    }

    function gradePass(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        cheats.prank(oracle);
        try vault.qaPass(taskId, keccak256("report")) {} catch {}
        _audit();
    }

    function gradeFail(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        cheats.prank(oracle);
        try vault.qaFail(taskId, keccak256("reason")) {} catch {}
        _audit();
    }

    function approve(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        cheats.prank(reviewer);
        try vault.approve(taskId) {} catch {}
        _audit();
    }

    function hold(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        cheats.prank(reviewer);
        try vault.hold(taskId, keccak256("hold")) {} catch {}
        _audit();
    }

    function dispute(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        cheats.prank(worker);
        try vault.dispute(taskId, keccak256("dispute")) {} catch {}
        _audit();
    }

    function resolve(uint256 rawTask, uint16 rawBps) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        uint16 bps = uint16(bound(rawBps, 0, 10_000));
        cheats.prank(reviewer);
        try vault.resolve(taskId, bps) {} catch {}
        _audit();
    }

    function release(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        try vault.release(taskId) {} catch {}
        _audit();
    }

    function refund(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        try vault.refund(taskId) {} catch {}
        _audit();
    }

    function expire(uint256 rawTask) external {
        uint256 taskId = _pick(rawTask);
        if (taskId == 0) return;
        try vault.expireClaim(taskId) {} catch {}
        _audit();
    }

    function withdraw(uint256 rawIndex, uint32 rawCount) external {
        if (batchIds.length == 0) return;
        bytes32 id = batchIds[bound(rawIndex, 0, batchIds.length - 1)];
        (,,, uint32 unclaimed,,,,) = vault.batches(id);
        if (unclaimed == 0) return;
        uint32 count = uint32(bound(rawCount, 1, unclaimed));
        cheats.prank(client);
        try vault.withdrawUnclaimed(id, count) {} catch {}
        _audit();
    }

    function warpForward(uint256 rawSecs) external {
        cheats.warp(block.timestamp + bound(rawSecs, 0, 7 days));
        _audit();
    }

    function _pick(uint256 rawTask) internal view returns (uint256) {
        uint256 n = vault.taskSeq();
        if (n == 0) return 0;
        return bound(rawTask, 1, n);
    }

    function _audit() internal {
        uint256 n = vault.taskSeq();
        for (uint256 i = 1; i <= n; i++) {
            (, EscrowVault.TaskState state,,,,,,,,,,,,) = vault.tasks(i);
            bool terminal = state == EscrowVault.TaskState.Released || state == EscrowVault.TaskState.Refunded
                || state == EscrowVault.TaskState.Resolved || state == EscrowVault.TaskState.Expired;
            if (terminal) {
                seenTerminal[i] = true;
            } else if (seenTerminal[i]) {
                terminalViolations = 1;
            }
        }
    }
}

/// ESC-20: the token balance covers every funded obligation, and a task is terminal at most once.
contract EscrowVaultInvariantTest is Test {
    uint64 constant HITL = 100_000_000;
    uint16 constant FEE_BPS = 300;
    uint16 constant QA_BPS = 3333;
    uint32 constant MIN_W = 60;
    uint32 constant MAX_W = 30 days;
    uint32 constant DISPUTE_W = 600;

    MockBUSD busd;
    EscrowVault vault;
    EscrowHandler handler;

    function setUp() public {
        busd = new MockBUSD();
        address admin = makeAddr("admin");
        address client = makeAddr("client");
        address worker = makeAddr("worker");
        address payout = makeAddr("payout");
        address treasury = makeAddr("treasury");
        address qaPool = makeAddr("qa");
        address verifier = makeAddr("verifier");
        address relayer = makeAddr("relayer");
        address oracle = makeAddr("oracle");
        address reviewer = makeAddr("reviewer");

        vault = new EscrowVault(
            address(busd), treasury, qaPool, admin, HITL, FEE_BPS, QA_BPS, MIN_W, MAX_W, DISPUTE_W, false, 0
        );
        vm.startPrank(admin);
        vault.grantRole(vault.VERIFIER(), verifier);
        vault.grantRole(vault.RELAYER(), relayer);
        vault.grantRole(vault.QA_ORACLE(), oracle);
        vault.grantRole(vault.REVIEWER(), reviewer);
        vm.stopPrank();
        vm.prank(verifier);
        vault.registerWorker(worker, payout, 20);

        handler = new EscrowHandler(vault, busd, client, worker, oracle, reviewer, relayer);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = handler.fund.selector;
        selectors[1] = handler.claim.selector;
        selectors[2] = handler.submitWork.selector;
        selectors[3] = handler.gradePass.selector;
        selectors[4] = handler.gradeFail.selector;
        selectors[5] = handler.approve.selector;
        selectors[6] = handler.hold.selector;
        selectors[7] = handler.dispute.selector;
        selectors[8] = handler.resolve.selector;
        selectors[9] = handler.release.selector;
        selectors[10] = handler.refund.selector;
        selectors[11] = handler.expire.selector;
        selectors[12] = handler.withdraw.selector;
        selectors[13] = handler.warpForward.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_solvency() public view {
        assertGe(busd.balanceOf(address(vault)), vault.obligations());
    }

    function invariant_terminal_once() public view {
        assertEq(handler.terminalViolations(), 0);
    }
}
