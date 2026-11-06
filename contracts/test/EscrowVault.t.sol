// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowVault} from "../src/EscrowVault.sol";
import {MockBUSD} from "../src/mocks/MockBUSD.sol";
import {MockScheduleService} from "../src/mocks/MockScheduleService.sol";

contract EscrowVaultTest is Test {
    uint64 constant HITL = 100_000_000; // 100 bUSD
    uint16 constant FEE_BPS = 300;
    uint16 constant QA_BPS = 3333;
    uint32 constant MIN_W = 60;
    uint32 constant MAX_W = 30 days;
    uint32 constant DISPUTE_W = 600;
    uint64 constant DUAL = 1_000_000_000; // 1,000 bUSD

    MockBUSD busd;
    EscrowVault vault;
    EscrowVault scheduled;

    address admin = makeAddr("admin");
    address client = makeAddr("client");
    address worker = makeAddr("worker");
    address workerB = makeAddr("workerB");
    address payout = makeAddr("payout");
    address payoutB = makeAddr("payoutB");
    address treasury = makeAddr("treasury");
    address qaPool = makeAddr("qa");
    address verifier = makeAddr("verifier");
    address relayer = makeAddr("relayer");
    address oracle = makeAddr("oracle");
    address reviewer = makeAddr("reviewer");

    uint256 nonce;

    function setUp() public {
        busd = new MockBUSD();
        vault = _deploy(false);
        scheduled = _deploy(true);
        _roles(vault);
        _roles(scheduled);
        _register(vault, worker, payout, 3);
        _register(vault, workerB, payoutB, 3);
        _register(scheduled, worker, payout, 3);
    }

    function test_instant_path() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        uint256 fee = _fee(40_000_000);
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));

        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Released));
        assertEq(busd.balanceOf(payout), 40_000_000);
        assertEq(busd.balanceOf(treasury) + busd.balanceOf(qaPool), fee);
        assertEq(busd.balanceOf(address(vault)), 0);
        assertEq(vault.obligations(), 0);
        assertEq(_qa(fee) + _treasury(fee), fee);
    }

    function test_approved_path() public {
        bytes32 id = _fund(vault, 250_000_000, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.AwaitingApproval));

        vm.prank(reviewer);
        vault.approve(taskId);
        assertEq(busd.balanceOf(payout), 250_000_000);
        assertEq(busd.balanceOf(address(vault)), 0);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Released));
    }

    function test_timeout_from_submitted() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        vault.release(taskId);
        assertEq(busd.balanceOf(payout), 40_000_000);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Released));
    }

    function test_timeout_from_awaiting_approval() public {
        bytes32 id = _fund(vault, 250_000_000, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        vault.release(taskId);
        assertEq(busd.balanceOf(payout), 250_000_000);
    }

    function test_release_before_deadline_reverts() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.expectRevert(EscrowVault.NotDue.selector);
        vault.release(taskId);
    }

    function test_revise_then_pass() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("v1"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("reason"));
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Revising));

        vm.prank(worker);
        vault.resubmit(taskId, keccak256("v2"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        assertEq(busd.balanceOf(payout), 40_000_000);
    }

    function test_resubmit_deadline_is_capped() public {
        bytes32 id = _fundWindows(vault, 40_000_000, 1, 1000, 1000, 100);
        uint256 taskId = _claim(id, worker);
        uint64 start = uint64(block.timestamp);
        _submit(taskId, worker, keccak256("v1"));
        vm.warp(start + 10);
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("reason"));
        (, uint64 actionDeadline,,,) = _deadlines(taskId);
        assertEq(actionDeadline, start + 10 + 100);

        vm.warp(actionDeadline - 1);
        vm.prank(worker);
        vault.resubmit(taskId, keccak256("v2"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        assertEq(reviewDeadline, start + 1000 + 100);
        assertLe(reviewDeadline - start, 1000 + 100);
    }

    function test_revise_then_refund() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 before = busd.balanceOf(client);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("v1"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("reason"));
        (, uint64 actionDeadline,,,) = _deadlines(taskId);
        vm.warp(actionDeadline - 1);
        vm.expectRevert(EscrowVault.NotDue.selector);
        vault.refund(taskId);
        vm.warp(actionDeadline);
        vault.refund(taskId);
        uint256 unit = 40_000_000 + _fee(40_000_000);
        assertEq(busd.balanceOf(client), before + unit);
        assertEq(busd.balanceOf(payout), 0);
        assertEq(busd.balanceOf(address(vault)), 0);
    }

    function test_fail_twice_then_refund() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("v1"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("r1"));
        vm.prank(worker);
        vault.resubmit(taskId, keccak256("v2"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("r2"));
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Failed));
        (, uint64 actionDeadline,,,) = _deadlines(taskId);
        vm.warp(actionDeadline);
        vault.refund(taskId);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Refunded));
        assertEq(busd.balanceOf(address(vault)), 0);
    }

    function test_fail_twice_then_dispute_then_resolve() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("v1"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("r1"));
        vm.prank(worker);
        vault.resubmit(taskId, keccak256("v2"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("r2"));
        vm.prank(worker);
        vault.dispute(taskId, keccak256("contest"));
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Disputed));
        vm.prank(reviewer);
        vault.resolve(taskId, 5000);
        _assertConserved(40_000_000);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Resolved));
    }

    function test_client_hold_then_resolve() public {
        bytes32 id = _fund(vault, 250_000_000, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(client);
        vault.hold(taskId, keccak256("concern"));
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Disputed));
        vm.prank(reviewer);
        vault.resolve(taskId, 2500);
        _assertConserved(250_000_000);
    }

    function test_hold_after_deadline_reverts() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        vm.prank(client);
        vm.expectRevert(EscrowVault.NotDue.selector);
        vault.hold(taskId, keccak256("late"));
    }

    function test_dispute_timeout_pays_worker() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(reviewer);
        vault.hold(taskId, keccak256("hold"));
        (,, uint64 disputeDeadline,,) = _deadlines(taskId);
        vm.warp(disputeDeadline);
        vault.release(taskId);
        assertEq(busd.balanceOf(payout), 40_000_000);
        assertEq(busd.balanceOf(treasury) + busd.balanceOf(qaPool), _fee(40_000_000));
        assertEq(busd.balanceOf(address(vault)), 0);
    }

    function test_expire_claim_returns_to_pool() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        (uint64 workDeadline,,,,) = _deadlines(taskId);
        vm.expectRevert(EscrowVault.NotDue.selector);
        vault.expireClaim(taskId);
        vm.warp(workDeadline);
        vault.expireClaim(taskId);
        assertEq(_unclaimed(id), 1);
        (,,,, uint32 inFlight,) = _worker(vault, worker);
        assertEq(inFlight, 0);
        uint256 again = _claim(id, worker);
        assertEq(_state(again), uint256(EscrowVault.TaskState.Claimed));
    }

    function test_withdraw_unclaimed_leaves_claimed() public {
        bytes32 id = _fund(vault, 40_000_000, 3);
        uint256 taskId = _claim(id, worker);
        uint256 unit = 40_000_000 + _fee(40_000_000);
        uint256 clientBefore = busd.balanceOf(client);
        vm.prank(client);
        vault.withdrawUnclaimed(id, 2);
        assertEq(busd.balanceOf(client), clientBefore + unit * 2);
        assertEq(_unclaimed(id), 0);
        assertEq(busd.balanceOf(address(vault)), unit);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        assertEq(busd.balanceOf(payout), 40_000_000);
        assertEq(busd.balanceOf(address(vault)), 0);
    }

    function test_stranger_cannot_withdraw() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        vm.expectRevert(EscrowVault.NotClient.selector);
        vault.withdrawUnclaimed(id, 1);
    }

    function test_direct_claim_above_threshold_reverts() public {
        bytes32 id = _fund(vault, 250_000_000, 1);
        vm.prank(worker);
        vm.expectRevert(EscrowVault.DirectClaimTooLarge.selector);
        vault.claim(id);
        uint256 taskId = _claimFor(id, worker);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Claimed));
    }

    function test_direct_claim_at_threshold_allowed() public {
        bytes32 id = _fund(vault, HITL, 1);
        uint256 taskId = _claim(id, worker);
        assertGt(taskId, 0);
    }

    function test_frozen_worker_reverts_and_keeps_state() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        busd.setFrozen(payout, true);
        uint256 bal = busd.balanceOf(address(vault));
        vm.prank(oracle);
        vm.expectRevert(EscrowVault.TransferFailed.selector);
        vault.qaPass(taskId, keccak256("report"));
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Submitted));
        assertEq(busd.balanceOf(address(vault)), bal);
        assertEq(vault.obligations(), bal);

        busd.setFrozen(payout, false);
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        assertEq(busd.balanceOf(payout), 40_000_000);
    }

    function test_release_if_due_is_noop_after_payment() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        uint256 bal = busd.balanceOf(payout);
        assertFalse(vault.releaseIfDue(taskId));
        assertEq(busd.balanceOf(payout), bal);
    }

    function test_release_if_due_pays_when_due() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        assertTrue(vault.releaseIfDue(taskId));
        assertEq(busd.balanceOf(payout), 40_000_000);
        assertFalse(vault.releaseIfDue(taskId));
    }

    function test_short_allowance_reverts() public {
        bytes32 id = keccak256("short");
        uint64 pay = 40_000_000;
        uint256 total = (uint256(pay) + _fee(pay));
        busd.mint(client, total);
        vm.prank(client);
        busd.approve(address(vault), total - 1);
        vm.prank(client);
        vm.expectRevert(EscrowVault.TransferFailed.selector);
        vault.fundBatch(id, 1, pay, 3600, 3600, 3600);
        assertEq(vault.obligations(), 0);
    }

    function test_window_too_short_reverts() public {
        vm.expectRevert(EscrowVault.BadWindow.selector);
        vm.prank(client);
        vault.fundBatch(keccak256("w"), 1, 1_000_000, MIN_W - 1, 3600, 3600);
    }

    function test_pause_blocks_fund_and_claim_not_release() public {
        bytes32 id = _fund(vault, 40_000_000, 2);
        uint256 taskId = _claim(id, worker);
        vm.prank(admin);
        vault.setPaused(true);
        vm.prank(client);
        vm.expectRevert(EscrowVault.Paused.selector);
        vault.fundBatch(keccak256("other"), 1, 40_000_000, 3600, 3600, 3600);
        vm.prank(workerB);
        vm.expectRevert(EscrowVault.Paused.selector);
        vault.claim(id);

        _submit(taskId, worker, keccak256("work"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        vault.release(taskId);
        assertEq(busd.balanceOf(payout), 40_000_000);
    }

    function test_admin_cannot_touch_locked_task() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(admin);
        vm.expectRevert(EscrowVault.NotDue.selector);
        vault.release(taskId);
        vm.prank(admin);
        vm.expectRevert(EscrowVault.BadState.selector);
        vault.refund(taskId);
        bytes32 reviewerRole = vault.REVIEWER();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(EscrowVault.NotRole.selector, reviewerRole));
        vault.resolve(taskId, 0);
        vm.prank(admin);
        vm.expectRevert(EscrowVault.NotClient.selector);
        vault.withdrawUnclaimed(id, 1);
    }

    function test_in_flight_cap() public {
        _register(vault, worker, payout, 1);
        bytes32 id = _fund(vault, 40_000_000, 2);
        _claim(id, worker);
        vm.prank(worker);
        vm.expectRevert(EscrowVault.InFlightCap.selector);
        vault.claim(id);
    }

    function test_payout_is_fixed_at_claim() public {
        bytes32 id = _fund(vault, 40_000_000, 2);
        uint256 first = _claim(id, worker);
        vm.prank(verifier);
        vault.setWorkerPayout(worker, payoutB);
        uint256 second = _claim(id, worker);
        _submit(first, worker, keccak256("a"));
        _submit(second, worker, keccak256("b"));
        vm.prank(oracle);
        vault.qaPass(first, keccak256("r"));
        vm.prank(oracle);
        vault.qaPass(second, keccak256("r"));
        assertEq(busd.balanceOf(payout), 40_000_000);
        assertEq(busd.balanceOf(payoutB), 40_000_000);
    }

    function test_inactive_worker_cannot_claim() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        vm.prank(verifier);
        vault.setWorkerStatus(worker, false);
        vm.prank(worker);
        vm.expectRevert(EscrowVault.WorkerInactive.selector);
        vault.claim(id);
    }

    function test_fee_split_dust_goes_to_treasury() public {
        // pay 3334 -> fee 100. qa share 3333 bps -> 33, treasury 67.
        uint64 pay = 3334;
        bytes32 id = _fund(vault, pay, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        assertEq(busd.balanceOf(payout), pay);
        assertEq(busd.balanceOf(qaPool), 33);
        assertEq(busd.balanceOf(treasury), 67);
        assertEq(busd.balanceOf(address(vault)), 0);
    }

    function test_terminal_state_sticks() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        vm.expectRevert(EscrowVault.BadState.selector);
        vault.release(taskId);
        vm.expectRevert(EscrowVault.BadState.selector);
        vault.refund(taskId);
        vm.prank(worker);
        vm.expectRevert(EscrowVault.BadState.selector);
        vault.submit(taskId, keccak256("again"));
    }

    function test_schedule_on_submit() public {
        MockScheduleService impl = new MockScheduleService();
        vm.etch(scheduled.HSS(), address(impl).code);
        MockScheduleService hss = MockScheduleService(scheduled.HSS());
        hss.setCapacity(true);

        bytes32 id = _fund(scheduled, 40_000_000, 1);
        vm.prank(worker);
        uint256 taskId = scheduled.claim(id);
        vm.prank(worker);
        scheduled.submit(taskId, keccak256("work"));

        assertEq(_scheduleOf(scheduled, taskId), address(0x5C11ED));
        (, , , , uint64 reviewDeadline) = _deadlinesOf(scheduled, taskId);
        assertEq(hss.lastExpiry(), reviewDeadline);
        assertEq(hss.lastTo(), address(scheduled));
        bytes memory data = hss.lastData();
        bytes4 sel;
        assembly {
            sel := mload(add(data, 32))
        }
        assertEq(sel, scheduled.releaseIfDue.selector);
    }

    function test_schedule_defers_when_capacity_is_full() public {
        MockScheduleService impl = new MockScheduleService();
        vm.etch(scheduled.HSS(), address(impl).code);
        MockScheduleService hss = MockScheduleService(scheduled.HSS());

        bytes32 id = _fund(scheduled, 40_000_000, 1);
        vm.prank(worker);
        uint256 taskId = scheduled.claim(id);
        vm.prank(worker);
        scheduled.submit(taskId, keccak256("work"));
        (, , , , uint64 reviewDeadline) = _deadlinesOf(scheduled, taskId);
        assertEq(hss.lastExpiry(), uint256(reviewDeadline) + 1);
    }

    function test_low_hbar_emits() public {
        MockScheduleService impl = new MockScheduleService();
        vm.etch(scheduled.HSS(), address(impl).code);
        MockScheduleService(scheduled.HSS()).setCapacity(true);
        vm.prank(admin);
        scheduled.setHbarLowWatermark(1);
        bytes32 id = _fund(scheduled, 40_000_000, 1);
        vm.prank(worker);
        uint256 taskId = scheduled.claim(id);
        vm.expectEmit(false, false, false, true, address(scheduled));
        emit EscrowVault.HbarLow(0);
        vm.prank(worker);
        scheduled.submit(taskId, keccak256("work"));
    }

    function testFuzz_resolve_conserves(uint64 rawPay, uint16 rawBps) public {
        uint64 pay = uint64(bound(rawPay, 1, 1_000_000_000_000));
        uint16 bps = uint16(bound(rawBps, 0, 10_000));
        bytes32 id = _fund(vault, pay, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(reviewer);
        vault.hold(taskId, keccak256("hold"));
        vm.prank(reviewer);
        vault.resolve(taskId, bps);
        _assertConserved(pay);
    }

    function testFuzz_release_conserves(uint64 rawPay) public {
        uint64 pay = uint64(bound(rawPay, 1, 1_000_000_000_000));
        bytes32 id = _fund(vault, pay, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        vault.release(taskId);
        _assertConserved(pay);
    }

    // ---------- dual review and reasons ----------

    function test_dual_review_needs_two_distinct_reviewers() public {
        address reviewerB = makeAddr("reviewerB");
        bytes32 role = vault.REVIEWER();
        vm.prank(admin);
        vault.grantRole(role, reviewerB);

        uint64 pay = 1_500_000_000; // 1,500 bUSD, above DUAL
        bytes32 id = _fund(vault, pay, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));

        vm.prank(reviewer);
        vault.approve(taskId);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.AwaitingApproval));
        assertEq(vault.firstApprover(taskId), reviewer);
        assertEq(busd.balanceOf(payout), 0);

        vm.prank(reviewer);
        vm.expectRevert(EscrowVault.SameReviewer.selector);
        vault.approve(taskId);

        vm.prank(reviewerB);
        vault.approve(taskId);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Released));
        _assertConserved(pay);
    }

    function test_dual_review_does_not_block_timeout() public {
        uint64 pay = 1_500_000_000;
        bytes32 id = _fund(vault, pay, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        vm.prank(reviewer);
        vault.approve(taskId);
        (, , , , uint64 reviewDeadline) = _deadlines(taskId);
        vm.warp(reviewDeadline);
        vault.release(taskId);
        _assertConserved(pay);
    }

    function test_single_review_at_dual_threshold() public {
        uint64 pay = DUAL;
        bytes32 id = _fund(vault, pay, 1);
        uint256 taskId = _claimFor(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaPass(taskId, keccak256("report"));
        vm.prank(reviewer);
        vault.approve(taskId);
        assertEq(_state(taskId), uint256(EscrowVault.TaskState.Released));
    }

    function test_hold_without_reason_reverts() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(reviewer);
        vm.expectRevert(EscrowVault.MissingReason.selector);
        vault.hold(taskId, bytes32(0));
    }

    function test_dispute_without_reason_reverts() public {
        bytes32 id = _fund(vault, 40_000_000, 1);
        uint256 taskId = _claim(id, worker);
        _submit(taskId, worker, keccak256("work"));
        vm.prank(oracle);
        vault.qaFail(taskId, keccak256("bad"));
        vm.prank(worker);
        vm.expectRevert(EscrowVault.MissingReason.selector);
        vault.dispute(taskId, bytes32(0));
    }

    function test_dual_threshold_below_hitl_is_rejected() public {
        vm.expectRevert(EscrowVault.BadConfig.selector);
        new EscrowVault(address(busd), treasury, qaPool, admin, HITL, FEE_BPS, QA_BPS, MIN_W, MAX_W, DISPUTE_W, false, 0, HITL - 1);
    }

    // ---------- helpers ----------

    function _deploy(bool scheduling) internal returns (EscrowVault v) {
        v = new EscrowVault(
            address(busd), treasury, qaPool, admin, HITL, FEE_BPS, QA_BPS, MIN_W, MAX_W, DISPUTE_W, scheduling, 0, DUAL
        );
    }

    function _roles(EscrowVault v) internal {
        vm.startPrank(admin);
        v.grantRole(v.VERIFIER(), verifier);
        v.grantRole(v.RELAYER(), relayer);
        v.grantRole(v.QA_ORACLE(), oracle);
        v.grantRole(v.REVIEWER(), reviewer);
        vm.stopPrank();
    }

    function _register(EscrowVault v, address who, address payTo, uint32 cap) internal {
        vm.prank(verifier);
        v.registerWorker(who, payTo, cap);
    }

    function _fund(EscrowVault v, uint64 pay, uint32 count) internal returns (bytes32 id) {
        return _fundWindows(v, pay, count, 3600, 3600, 3600);
    }

    function _fundWindows(EscrowVault v, uint64 pay, uint32 count, uint32 reviewW, uint32 workW, uint32 revW)
        internal
        returns (bytes32 id)
    {
        id = keccak256(abi.encode(++nonce, pay, count, address(v)));
        uint256 total = (uint256(pay) + _fee(pay)) * count;
        busd.mint(client, total);
        vm.startPrank(client);
        busd.approve(address(v), total);
        v.fundBatch(id, count, pay, reviewW, workW, revW);
        vm.stopPrank();
    }

    function _claim(bytes32 id, address who) internal returns (uint256 taskId) {
        vm.prank(who);
        taskId = vault.claim(id);
    }

    function _claimFor(bytes32 id, address who) internal returns (uint256 taskId) {
        vm.prank(relayer);
        taskId = vault.claimFor(id, who);
    }

    function _submit(uint256 taskId, address who, bytes32 hash) internal {
        vm.prank(who);
        vault.submit(taskId, hash);
    }

    function _fee(uint64 pay) internal pure returns (uint256) {
        return uint256(pay) * FEE_BPS / 10_000;
    }

    function _qa(uint256 fee) internal pure returns (uint256) {
        return fee * QA_BPS / 10_000;
    }

    function _treasury(uint256 fee) internal pure returns (uint256) {
        return fee - _qa(fee);
    }

    /// After one task is fully settled, the vault is empty and every base unit
    /// sits with the worker payout, the client (returned share only; fund pulled
    /// the whole unit), the treasury, or the QA pool.
    function _assertConserved(uint64 pay) internal view {
        uint256 unit = uint256(pay) + _fee(pay);
        assertEq(busd.balanceOf(address(vault)), 0);
        assertEq(vault.obligations(), 0);
        uint256 workerAmt = busd.balanceOf(payout) + busd.balanceOf(payoutB);
        uint256 sum = workerAmt + busd.balanceOf(client) + busd.balanceOf(treasury) + busd.balanceOf(qaPool);
        assertEq(sum, unit);
    }

    function _deadlines(uint256 taskId)
        internal
        view
        returns (uint64 workDeadline, uint64 actionDeadline, uint64 disputeDeadline, uint64 firstSubmittedAt, uint64 reviewDeadline)
    {
        return _deadlinesOf(vault, taskId);
    }

    function _deadlinesOf(EscrowVault v, uint256 taskId)
        internal
        view
        returns (uint64 workDeadline, uint64 actionDeadline, uint64 disputeDeadline, uint64 firstSubmittedAt, uint64 reviewDeadline)
    {
        (
            ,
            ,
            ,
            ,
            workDeadline,
            reviewDeadline,
            actionDeadline,
            disputeDeadline,
            firstSubmittedAt,
            ,
            ,
            ,
            ,
        ) = v.tasks(taskId);
    }

    function _state(uint256 taskId) internal view returns (uint256) {
        (, EscrowVault.TaskState state,,,,,,,,,,,,) = vault.tasks(taskId);
        return uint256(state);
    }

    function _unclaimed(bytes32 id) internal view returns (uint32 unclaimed) {
        (,,, unclaimed,,,,) = vault.batches(id);
    }

    function _scheduleOf(EscrowVault v, uint256 taskId) internal view returns (address schedule) {
        (,,,,,,,,,,,,, schedule) = v.tasks(taskId);
    }

    function _worker(EscrowVault v, address who)
        internal
        view
        returns (bool registered, bool active, address payTo, uint32 cap, uint32 inFlight, uint32 inFlightCap)
    {
        (registered, active, payTo, inFlight, inFlightCap) = v.workers(who);
        cap = inFlightCap;
    }
}
