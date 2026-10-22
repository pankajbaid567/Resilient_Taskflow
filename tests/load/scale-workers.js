#!/usr/bin/env node
/**
 * Automated Worker Scaling Script
 *
 * This script automates worker scaling for the worker-scaling.test.js
 * Run this in parallel with the k6 test to automatically scale workers
 * according to the defined schedule.
 *
 * Usage:
 *   # Terminal 1: Start the load test
 *   pnpm load:scaling
 *
 *   # Terminal 2: Run this script
 *   node tests/load/scale-workers.js
 */

const { execSync } = require('child_process');

// =============================================================================
// Configuration
// =============================================================================

const SCALING_SCHEDULE = [
  { time: 0, workers: 1, duration: 120 }, // 0:00-2:00 → 1 worker
  { time: 120, workers: 5, duration: 120 }, // 2:00-4:00 → 5 workers
  { time: 240, workers: 10, duration: 120 }, // 4:00-6:00 → 10 workers
  { time: 360, workers: 5, duration: 120 }, // 6:00-8:00 → 5 workers
  { time: 480, workers: 1, duration: 120 }, // 8:00-10:00 → 1 worker
];

const DOCKER_COMPOSE_CMD = 'docker-compose';
const SERVICE_NAME = 'worker';

// =============================================================================
// Utilities
// =============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function executeCommand(command) {
  try {
    log(`Executing: ${command}`);
    const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
    return output.trim();
  } catch (error) {
    log(`ERROR: ${error.message}`);
    throw error;
  }
}

function scaleWorkers(count) {
  log(`Scaling to ${count} worker(s)...`);
  try {
    if (count === 1) {
      // For 1 worker, use docker-compose up without --scale
      executeCommand(`${DOCKER_COMPOSE_CMD} up -d ${SERVICE_NAME}`);
    } else {
      // For multiple workers, use --scale flag
      executeCommand(
        `${DOCKER_COMPOSE_CMD} up -d --scale ${SERVICE_NAME}=${count}`
      );
    }
    log(`Successfully scaled to ${count} worker(s)`);
    return true;
  } catch (error) {
    log(`Failed to scale workers: ${error.message}`);
    return false;
  }
}

function getActiveWorkers() {
  try {
    const output = executeCommand(
      `${DOCKER_COMPOSE_CMD} ps ${SERVICE_NAME} --format json`
    );
    const lines = output.split('\n').filter((line) => line.trim());
    const containers = lines.map((line) => JSON.parse(line));
    const running = containers.filter((c) => c.State === 'running');
    return running.length;
  } catch (error) {
    log(`Failed to get active workers: ${error.message}`);
    return 0;
  }
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// Main Script
// =============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('AUTOMATED WORKER SCALING SCRIPT');
  console.log('='.repeat(80));
  console.log('');
  console.log('Scaling Schedule:');
  SCALING_SCHEDULE.forEach((step) => {
    console.log(
      `  ${formatTime(step.time)} - ${formatTime(step.time + step.duration)}: ${step.workers} worker(s)`
    );
  });
  console.log('');
  console.log('='.repeat(80));
  console.log('');

  // Verify docker-compose is available
  try {
    executeCommand(`${DOCKER_COMPOSE_CMD} version`);
  } catch (error) {
    log('ERROR: docker-compose not found. Please install docker-compose.');
    process.exit(1);
  }

  const startTime = Date.now();
  let currentStepIndex = 0;

  // Initial scaling
  log('Starting worker scaling automation...');
  scaleWorkers(SCALING_SCHEDULE[0].workers);

  // Main loop
  while (currentStepIndex < SCALING_SCHEDULE.length) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const currentStep = SCALING_SCHEDULE[currentStepIndex];
    const nextStep = SCALING_SCHEDULE[currentStepIndex + 1];

    // Check if it's time to scale
    if (nextStep && elapsedSeconds >= nextStep.time) {
      log(`Reached ${formatTime(elapsedSeconds)} - Time to scale!`);
      scaleWorkers(nextStep.workers);
      currentStepIndex++;
    }

    // Status update
    const activeWorkers = getActiveWorkers();
    const timeInStep = elapsedSeconds - currentStep.time;
    const stepProgress = ((timeInStep / currentStep.duration) * 100).toFixed(0);

    log(
      `Status: ${formatTime(elapsedSeconds)} | Workers: ${activeWorkers}/${currentStep.workers} | Step ${currentStepIndex + 1}/${SCALING_SCHEDULE.length} (${stepProgress}%)`
    );

    // Wait before next check
    await sleep(10); // Check every 10 seconds

    // Exit if we've completed all steps
    if (currentStepIndex === SCALING_SCHEDULE.length - 1) {
      const totalDuration = SCALING_SCHEDULE.reduce(
        (sum, step) => sum + step.duration,
        0
      );
      if (elapsedSeconds >= totalDuration) {
        log('All scaling steps completed!');
        break;
      }
    }
  }

  console.log('');
  console.log('='.repeat(80));
  console.log('WORKER SCALING COMPLETE');
  console.log('='.repeat(80));
  log('Final worker count: ' + getActiveWorkers());
  log("Test complete. You can now stop the k6 test if it hasn't finished.");
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

process.on('SIGINT', () => {
  log('Received SIGINT. Cleaning up...');
  log(
    'Workers left at current scale. Use docker-compose down to stop all services.'
  );
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM. Cleaning up...');
  log(
    'Workers left at current scale. Use docker-compose down to stop all services.'
  );
  process.exit(0);
});

// =============================================================================
// Run
// =============================================================================

main().catch((error) => {
  console.error('FATAL ERROR:', error);
  process.exit(1);
});
