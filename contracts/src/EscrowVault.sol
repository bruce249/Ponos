// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HederaResponseCodes, IHederaScheduleService} from "./hedera/IHederaScheduleService.sol";

/// @title EscrowVault
/// @notice Escrow for Byline Work. A lab locks `pay + fee` per task before anyone starts.
///         Silence pays the worker. A reviewer can stop a large payment only with an on-chain hold.
/// @dev Not upgradeable. The admin can pause new funding and claims, and cannot move locked funds.
///      HIP-1215 scheduling is a constructor flag. `release` stays permissionless either way.
contract EscrowVault {
    enum TaskState {
        None,
        Claimed,
        Submitted,
        AwaitingApproval,
        Revising,
        Failed,
        Disputed,
        Released,
        Refunded,
        Resolved,
        Expired
    }

    struct Batch {
        address client;
        uint64 payPerTask;
        uint32 taskCount;
        uint32 unclaimed;
        uint32 reviewWindow;
        uint32 workWindow;
        uint32 revisionWindow;
        bool exists;
    }

    struct Task {
        bytes32 batchId;
        TaskState state;
        address worker;
        address payout;
        uint64 workDeadline;
        uint64 reviewDeadline;
        uint64 actionDeadline;
        uint64 disputeDeadline;
        uint64 firstSubmittedAt;
        bytes32 workHash;
        bytes32 reportHash;
        bytes32 reasonHash;
        uint8 failCount;
        address schedule;
    }

    struct WorkerInfo {
        bool registered;
        bool active;
        address payout;
        uint32 inFlight;
        uint32 inFlightCap;
    }

    bytes32 public constant VERIFIER = keccak256("VERIFIER");
    bytes32 public constant RELAYER = keccak256("RELAYER");
    bytes32 public constant QA_ORACLE = keccak256("QA_ORACLE");
    bytes32 public constant REVIEWER = keccak256("REVIEWER");

    bytes32 public constant PATH_INSTANT = "instant";
    bytes32 public constant PATH_APPROVED = "approved";
    bytes32 public constant PATH_TIMEOUT = "timeout";
    bytes32 public constant PATH_DISPUTE_TIMEOUT = "dispute_timeout";

    uint256 public constant SCHEDULE_GAS = 750_000;
    address public constant HSS = address(uint160(0x16b));
    uint16 public constant BPS = 10_000;

    address public immutable token;
    address public immutable treasury;
    address public immutable qaPool;
    uint64 public immutable hitlThreshold;
    uint16 public immutable platformFeeBps;
    uint16 public immutable qaPoolShareBps;
    uint32 public immutable minWindow;
    uint32 public immutable maxWindow;
    uint32 public immutable disputeWindow;
    bool public immutable schedulingEnabled;

    address public admin;
    bool public paused;
    uint256 public hbarLowWatermark;
    uint256 public obligations;
    uint256 public taskSeq;

    mapping(bytes32 => Batch) public batches;
    mapping(uint256 => Task) public tasks;
    mapping(address => WorkerInfo) public workers;
    mapping(address => mapping(bytes32 => bool)) public roles;

    uint256 private _locked;

    error Paused();
    error UnknownBatch();
    error BatchExists();
    error BadWindow();
    error ZeroTasks();
    error ZeroPay();
    error WorkerInactive();
    error InFlightCap();
    error DirectClaimTooLarge();
    error NoPayout();
    error NoneLeft();
    error NotWorker();
    error BadState();
    error NotDue();
    error NotClient();
    error NotAdmin();
    error NotRole(bytes32 role);
    error TransferFailed();
    error ScheduleFailed(int64 rc);
    error ScheduleUnavailable();
    error BadBps();
    error Reentrancy();
    error ZeroAddress();
    error BadConfig();

    event BatchFunded(
        bytes32 indexed batchId,
        address indexed client,
        uint32 taskCount,
        uint64 payPerTask,
        uint256 feePerTask,
        uint256 total,
        uint32 reviewWindow,
        uint32 workWindow,
        uint32 revisionWindow
    );
    event TaskClaimed(
        uint256 indexed taskId, bytes32 indexed batchId, address indexed worker, address payout, uint64 workDeadline, uint256 pay
    );
    event ClaimExpired(uint256 indexed taskId, bytes32 indexed batchId, address worker);
    event TaskSubmitted(
        uint256 indexed taskId,
        bytes32 indexed batchId,
        bytes32 workHash,
        uint64 reviewDeadline,
        address schedule,
        bool resubmitted
    );
    event QaPassed(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reportHash, bool awaitingApproval, uint256 pay);
    event QaFailed(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reasonHash, uint8 failCount, uint64 actionDeadline);
    event TaskApproved(uint256 indexed taskId, bytes32 indexed batchId);
    event TaskHeld(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reasonHash, uint64 disputeDeadline);
    event TaskDisputed(uint256 indexed taskId, bytes32 indexed batchId, bytes32 reasonHash, uint64 disputeDeadline);
    event TaskReleased(uint256 indexed taskId, bytes32 indexed batchId, address payout, uint256 pay, uint256 fee, bytes32 path);
    event TaskRefunded(uint256 indexed taskId, bytes32 indexed batchId, address client, uint256 amount);
    event TaskResolved(
        uint256 indexed taskId,
        bytes32 indexed batchId,
        uint16 workerBps,
        uint256 workerAmount,
        uint256 clientAmount,
        uint256 feeAmount
    );
    event UnclaimedWithdrawn(bytes32 indexed batchId, address indexed client, uint32 count, uint256 amount);
    event WorkerRegistered(address indexed worker, address payout, uint32 inFlightCap);
    event WorkerStatusSet(address indexed worker, bool active);
    event WorkerPayoutSet(address indexed worker, address payout);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event PausedSet(bool paused);
    event HbarLow(uint256 balance);
    event ScheduleCapacityDeferred(uint256 indexed taskId, uint64 expiry);
    event TokenAssociated(uint256 responseCode);

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRole(bytes32 role) {
        if (!roles[msg.sender][role]) revert NotRole(role);
        _;
    }

    constructor(
        address token_,
        address treasury_,
        address qaPool_,
        address admin_,
        uint64 hitlThreshold_,
        uint16 platformFeeBps_,
        uint16 qaPoolShareBps_,
        uint32 minWindow_,
        uint32 maxWindow_,
        uint32 disputeWindow_,
        bool schedulingEnabled_,
        uint256 hbarLowWatermark_
    ) {
        if (token_ == address(0) || treasury_ == address(0) || qaPool_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        if (platformFeeBps_ > BPS || qaPoolShareBps_ > BPS) revert BadConfig();
        if (minWindow_ == 0 || minWindow_ > maxWindow_ || disputeWindow_ == 0) revert BadConfig();
        token = token_;
        treasury = treasury_;
        qaPool = qaPool_;
        admin = admin_;
        hitlThreshold = hitlThreshold_;
        platformFeeBps = platformFeeBps_;
        qaPoolShareBps = qaPoolShareBps_;
        minWindow = minWindow_;
        maxWindow = maxWindow_;
        disputeWindow = disputeWindow_;
        schedulingEnabled = schedulingEnabled_;
        hbarLowWatermark = hbarLowWatermark_;
    }

    receive() external payable {}

    // ---------- admin and roles ----------

    function grantRole(bytes32 role, address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        roles[account][role] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyAdmin {
        roles[account][role] = false;
        emit RoleRevoked(role, account);
    }

    /// Pauses new batches and claims only. Locked tasks keep every path, including release.
    function setPaused(bool next) external onlyAdmin {
        paused = next;
        emit PausedSet(next);
    }

    function setHbarLowWatermark(uint256 next) external onlyAdmin {
        hbarLowWatermark = next;
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
    }

    // ---------- workers ----------

    /// Payout changes apply only to claims made after this call.
    function registerWorker(address worker, address payout, uint32 inFlightCap) external onlyRole(VERIFIER) {
        if (worker == address(0) || payout == address(0)) revert ZeroAddress();
        if (inFlightCap == 0) revert BadConfig();
        WorkerInfo storage w = workers[worker];
        w.registered = true;
        w.active = true;
        w.payout = payout;
        w.inFlightCap = inFlightCap;
        emit WorkerRegistered(worker, payout, inFlightCap);
    }

    function setWorkerStatus(address worker, bool active) external onlyRole(VERIFIER) {
        WorkerInfo storage w = workers[worker];
        if (!w.registered) revert WorkerInactive();
        w.active = active;
        emit WorkerStatusSet(worker, active);
    }

    function setWorkerPayout(address worker, address payout) external onlyRole(VERIFIER) {
        if (payout == address(0)) revert ZeroAddress();
        WorkerInfo storage w = workers[worker];
        if (!w.registered) revert WorkerInactive();
        w.payout = payout;
        emit WorkerPayoutSet(worker, payout);
    }

    // ---------- funding ----------

    function fundBatch(
        bytes32 batchId,
        uint32 taskCount,
        uint64 payPerTask,
        uint32 reviewWindow,
        uint32 workWindow,
        uint32 revisionWindow
    ) external nonReentrant {
        if (paused) revert Paused();
        if (taskCount == 0) revert ZeroTasks();
        if (payPerTask == 0) revert ZeroPay();
        if (batches[batchId].exists) revert BatchExists();
        _checkWindow(reviewWindow);
        _checkWindow(workWindow);
        _checkWindow(revisionWindow);

        uint256 fee = _fee(payPerTask);
        uint256 unit = uint256(payPerTask) + fee;
        uint256 total = unit * uint256(taskCount);

        batches[batchId] = Batch({
            client: msg.sender,
            payPerTask: payPerTask,
            taskCount: taskCount,
            unclaimed: taskCount,
            reviewWindow: reviewWindow,
            workWindow: workWindow,
            revisionWindow: revisionWindow,
            exists: true
        });
        obligations += total;
        emit BatchFunded(batchId, msg.sender, taskCount, payPerTask, fee, total, reviewWindow, workWindow, revisionWindow);
        _pull(msg.sender, total);
    }

    function withdrawUnclaimed(bytes32 batchId, uint32 count) external nonReentrant {
        Batch storage b = batches[batchId];
        if (!b.exists) revert UnknownBatch();
        if (msg.sender != b.client) revert NotClient();
        if (count == 0 || count > b.unclaimed) revert NoneLeft();
        uint256 amount = uint256(count) * (uint256(b.payPerTask) + _fee(b.payPerTask));
        b.unclaimed -= count;
        obligations -= amount;
        emit UnclaimedWithdrawn(batchId, msg.sender, count, amount);
        _push(b.client, amount);
    }

    // ---------- claim, submit ----------

    function claim(bytes32 batchId) external nonReentrant returns (uint256 taskId) {
        return _claim(batchId, msg.sender, true);
    }

    function claimFor(bytes32 batchId, address worker) external onlyRole(RELAYER) nonReentrant returns (uint256 taskId) {
        return _claim(batchId, worker, false);
    }

    function expireClaim(uint256 taskId) external nonReentrant {
        Task storage t = tasks[taskId];
        if (t.state != TaskState.Claimed) revert BadState();
        if (block.timestamp < t.workDeadline) revert NotDue();
        Batch storage b = batches[t.batchId];
        address worker = t.worker;
        t.state = TaskState.Expired;
        b.unclaimed += 1;
        _leaveFlight(worker);
        emit ClaimExpired(taskId, t.batchId, worker);
    }

    function submit(uint256 taskId, bytes32 workHash) external nonReentrant {
        _submit(taskId, workHash, false, true);
    }

    function submitFor(uint256 taskId, bytes32 workHash) external onlyRole(RELAYER) nonReentrant {
        _submit(taskId, workHash, false, false);
    }

    function resubmit(uint256 taskId, bytes32 workHash) external nonReentrant {
        _submit(taskId, workHash, true, true);
    }

    function resubmitFor(uint256 taskId, bytes32 workHash) external onlyRole(RELAYER) nonReentrant {
        _submit(taskId, workHash, true, false);
    }

    // ---------- QA, review, dispute ----------

    function qaPass(uint256 taskId, bytes32 reportHash) external onlyRole(QA_ORACLE) nonReentrant {
        Task storage t = tasks[taskId];
        if (t.state != TaskState.Submitted) revert BadState();
        Batch storage b = batches[t.batchId];
        t.reportHash = reportHash;
        // Past the deadline, silence already owes the worker. Don't open a new wait.
        if (b.payPerTask > hitlThreshold && block.timestamp < t.reviewDeadline) {
            t.state = TaskState.AwaitingApproval;
            emit QaPassed(taskId, t.batchId, reportHash, true, b.payPerTask);
            return;
        }
        emit QaPassed(taskId, t.batchId, reportHash, false, b.payPerTask);
        _payWorker(taskId, block.timestamp >= t.reviewDeadline ? PATH_TIMEOUT : PATH_INSTANT);
    }

    function qaFail(uint256 taskId, bytes32 reasonHash) external onlyRole(QA_ORACLE) nonReentrant {
        Task storage t = tasks[taskId];
        if (t.state != TaskState.Submitted) revert BadState();
        if (block.timestamp >= t.reviewDeadline) revert NotDue();
        Batch storage b = batches[t.batchId];
        t.failCount += 1;
        t.reasonHash = reasonHash;
        if (t.failCount == 1) {
            uint64 cap = t.firstSubmittedAt + b.reviewWindow + b.revisionWindow;
            uint64 proposed = uint64(block.timestamp) + b.revisionWindow;
            t.actionDeadline = proposed < cap ? proposed : cap;
            t.state = TaskState.Revising;
        } else {
            t.actionDeadline = uint64(block.timestamp) + b.revisionWindow;
            t.state = TaskState.Failed;
        }
        emit QaFailed(taskId, t.batchId, reasonHash, t.failCount, t.actionDeadline);
    }

    function approve(uint256 taskId) external onlyRole(REVIEWER) nonReentrant {
        Task storage t = tasks[taskId];
        if (t.state != TaskState.AwaitingApproval) revert BadState();
        emit TaskApproved(taskId, t.batchId);
        _payWorker(taskId, PATH_APPROVED);
    }

    function hold(uint256 taskId, bytes32 reasonHash) external nonReentrant {
        Task storage t = tasks[taskId];
        if (t.state != TaskState.Submitted && t.state != TaskState.AwaitingApproval) revert BadState();
        if (block.timestamp >= t.reviewDeadline) revert NotDue();
        Batch storage b = batches[t.batchId];
        if (msg.sender != b.client && !roles[msg.sender][REVIEWER]) revert NotRole(REVIEWER);
        t.reasonHash = reasonHash;
        t.disputeDeadline = uint64(block.timestamp) + disputeWindow;
        t.state = TaskState.Disputed;
        emit TaskHeld(taskId, t.batchId, reasonHash, t.disputeDeadline);
    }

    function dispute(uint256 taskId, bytes32 reasonHash) external nonReentrant {
        _dispute(taskId, reasonHash, true);
    }

    function disputeFor(uint256 taskId, bytes32 reasonHash) external onlyRole(RELAYER) nonReentrant {
        _dispute(taskId, reasonHash, false);
    }

    /// @dev workerBps is the worker's share of `pay`. The platform fee is charged only on that share.
    ///      Rounding dust inside the fee split goes to the treasury. The three transfers sum to pay + fee.
    function resolve(uint256 taskId, uint16 workerBps) external onlyRole(REVIEWER) nonReentrant {
        if (workerBps > BPS) revert BadBps();
        Task storage t = tasks[taskId];
        if (t.state != TaskState.Disputed) revert BadState();
        Batch storage b = batches[t.batchId];
        uint256 pay = b.payPerTask;
        uint256 fee = _fee(b.payPerTask);
        uint256 unit = pay + fee;
        uint256 workerAmt = pay * uint256(workerBps) / BPS;
        uint256 feePlatform = fee * uint256(workerBps) / BPS;
        uint256 clientAmt = unit - workerAmt - feePlatform;
        address payout = t.payout;
        address worker = t.worker;
        address client = b.client;

        t.state = TaskState.Resolved;
        _leaveFlight(worker);
        obligations -= unit;
        emit TaskResolved(taskId, t.batchId, workerBps, workerAmt, clientAmt, feePlatform);
        _splitFee(feePlatform);
        _push(payout, workerAmt);
        _push(client, clientAmt);
    }

    /// Permissionless. Pays the worker after the review deadline, or after a dispute window with no resolution.
    function release(uint256 taskId) public nonReentrant {
        Task storage t = tasks[taskId];
        bytes32 path;
        if (t.state == TaskState.Submitted || t.state == TaskState.AwaitingApproval) {
            if (block.timestamp < t.reviewDeadline) revert NotDue();
            path = PATH_TIMEOUT;
        } else if (t.state == TaskState.Disputed) {
            if (block.timestamp < t.disputeDeadline) revert NotDue();
            path = PATH_DISPUTE_TIMEOUT;
        } else {
            revert BadState();
        }
        _payWorker(taskId, path);
    }

    /// Schedule target. Never reverts: a frozen worker or an early call leaves state unchanged
    /// so the keeper can retry. A later call after `qaPass` is a success with no transfer.
    function releaseIfDue(uint256 taskId) external returns (bool released) {
        Task storage t = tasks[taskId];
        if (t.state == TaskState.Submitted || t.state == TaskState.AwaitingApproval) {
            if (block.timestamp < t.reviewDeadline) return false;
        } else if (t.state == TaskState.Disputed) {
            if (block.timestamp < t.disputeDeadline) return false;
        } else {
            return false;
        }
        try this.release(taskId) {
            return true;
        } catch {
            return false;
        }
    }

    function refund(uint256 taskId) external nonReentrant {
        Task storage t = tasks[taskId];
        if (t.state != TaskState.Revising && t.state != TaskState.Failed) revert BadState();
        if (block.timestamp < t.actionDeadline) revert NotDue();
        Batch storage b = batches[t.batchId];
        uint256 amount = uint256(b.payPerTask) + _fee(b.payPerTask);
        address client = b.client;
        address worker = t.worker;
        t.state = TaskState.Refunded;
        _leaveFlight(worker);
        obligations -= amount;
        emit TaskRefunded(taskId, t.batchId, client, amount);
        _push(client, amount);
    }

    /// HIP-719 associate on the token facade. Called once from the deploy setup, not from tests.
    function associateToken() external {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("associate()"));
        require(ok, "associate call failed");
        uint256 rc = ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        emit TokenAssociated(rc);
    }

    // ---------- internals ----------

    function _claim(bytes32 batchId, address worker, bool direct) internal returns (uint256 taskId) {
        if (paused) revert Paused();
        Batch storage b = batches[batchId];
        if (!b.exists) revert UnknownBatch();
        if (b.unclaimed == 0) revert NoneLeft();
        WorkerInfo storage w = workers[worker];
        if (!w.registered || !w.active) revert WorkerInactive();
        if (w.inFlight >= w.inFlightCap) revert InFlightCap();
        if (direct && b.payPerTask > hitlThreshold) revert DirectClaimTooLarge();
        if (w.payout == address(0)) revert NoPayout();

        taskId = ++taskSeq;
        uint64 workDeadline = uint64(block.timestamp) + b.workWindow;
        tasks[taskId] = Task({
            batchId: batchId,
            state: TaskState.Claimed,
            worker: worker,
            payout: w.payout,
            workDeadline: workDeadline,
            reviewDeadline: 0,
            actionDeadline: 0,
            disputeDeadline: 0,
            firstSubmittedAt: 0,
            workHash: bytes32(0),
            reportHash: bytes32(0),
            reasonHash: bytes32(0),
            failCount: 0,
            schedule: address(0)
        });
        b.unclaimed -= 1;
        w.inFlight += 1;
        emit TaskClaimed(taskId, batchId, worker, w.payout, workDeadline, b.payPerTask);
    }

    function _submit(uint256 taskId, bytes32 workHash, bool revising, bool direct) internal {
        if (workHash == bytes32(0)) revert BadConfig();
        Task storage t = tasks[taskId];
        if (direct && msg.sender != t.worker) revert NotWorker();
        Batch storage b = batches[t.batchId];
        uint64 reviewDeadline;
        if (!revising) {
            if (t.state != TaskState.Claimed) revert BadState();
            if (block.timestamp >= t.workDeadline) revert NotDue();
            t.firstSubmittedAt = uint64(block.timestamp);
            reviewDeadline = uint64(block.timestamp) + b.reviewWindow;
        } else {
            if (t.state != TaskState.Revising) revert BadState();
            if (block.timestamp >= t.actionDeadline) revert NotDue();
            // Gap 3: the new review ends at the original cap, never later than review + revision.
            reviewDeadline = t.firstSubmittedAt + b.reviewWindow + b.revisionWindow;
        }
        t.workHash = workHash;
        t.reviewDeadline = reviewDeadline;
        t.state = TaskState.Submitted;
        address schedule = _scheduleRelease(taskId, reviewDeadline);
        t.schedule = schedule;
        emit TaskSubmitted(taskId, t.batchId, workHash, reviewDeadline, schedule, revising);
    }

    function _dispute(uint256 taskId, bytes32 reasonHash, bool direct) internal {
        Task storage t = tasks[taskId];
        if (direct && msg.sender != t.worker) revert NotWorker();
        if (t.state != TaskState.Revising && t.state != TaskState.Failed) revert BadState();
        if (block.timestamp >= t.actionDeadline) revert NotDue();
        t.reasonHash = reasonHash;
        t.disputeDeadline = uint64(block.timestamp) + disputeWindow;
        t.state = TaskState.Disputed;
        emit TaskDisputed(taskId, t.batchId, reasonHash, t.disputeDeadline);
    }

    function _payWorker(uint256 taskId, bytes32 path) internal {
        Task storage t = tasks[taskId];
        Batch storage b = batches[t.batchId];
        uint256 pay = b.payPerTask;
        uint256 fee = _fee(b.payPerTask);
        address payout = t.payout;
        address worker = t.worker;
        t.state = TaskState.Released;
        _leaveFlight(worker);
        obligations -= pay + fee;
        emit TaskReleased(taskId, t.batchId, payout, pay, fee, path);
        _splitFee(fee);
        _push(payout, pay);
    }

    function _splitFee(uint256 fee) internal {
        if (fee == 0) return;
        uint256 qa = fee * uint256(qaPoolShareBps) / BPS;
        uint256 toTreasury = fee - qa;
        _push(treasury, toTreasury);
        _push(qaPool, qa);
    }

    function _scheduleRelease(uint256 taskId, uint64 expiry) internal returns (address schedule) {
        if (!schedulingEnabled) return address(0);
        if (address(this).balance < hbarLowWatermark) emit HbarLow(address(this).balance);
        uint256 when = expiry;
        try IHederaScheduleService(HSS).hasScheduleCapacity(when, SCHEDULE_GAS) returns (bool ok) {
            if (!ok) {
                when += 1;
                emit ScheduleCapacityDeferred(taskId, uint64(when));
            }
        } catch {
            revert ScheduleUnavailable();
        }
        bytes memory data = abi.encodeCall(this.releaseIfDue, (taskId));
        (int64 rc, address sched) = IHederaScheduleService(HSS).scheduleCall(address(this), when, SCHEDULE_GAS, 0, data);
        if (rc != HederaResponseCodes.SUCCESS) revert ScheduleFailed(rc);
        return sched;
    }

    function _leaveFlight(address worker) internal {
        WorkerInfo storage w = workers[worker];
        if (w.inFlight > 0) w.inFlight -= 1;
    }

    function _checkWindow(uint32 window) internal view {
        if (window < minWindow || window > maxWindow) revert BadWindow();
    }

    function _fee(uint64 pay) internal view returns (uint256) {
        return uint256(pay) * uint256(platformFeeBps) / BPS;
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
