/**
 * Send Email Handler
 *
 * Example handler for sending emails.
 * In production, integrate with email service (SendGrid, AWS SES, etc.)
 */

import { createLogger } from '@taskflow/logger';
import type { JobHandlerContext } from '@taskflow/types';

const logger = createLogger({ component: 'SendEmailHandler' });

/**
 * Email payload schema
 */
interface EmailPayload {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Array<{
    filename: string;
    content: string;
  }>;
}

/**
 * Send email handler
 *
 * IMPORTANT: This handler must be idempotent!
 * - Check if email already sent before sending
 * - Use idempotency key in email metadata
 */
export async function sendEmailHandler(
  payloadInput: Record<string, unknown>,
  context: JobHandlerContext
): Promise<Record<string, unknown>> {
  const startTime = Date.now();
  const jobId = context.job.id;

  try {
    logger.info('Processing send-email job', {
      jobId,
      attempt: context.job.attempts,
      maxAttempts: context.job.maxAttempts,
    });

    // Validate payload
    const payload = validateEmailPayload(payloadInput);

    // Check if already sent (idempotency)
    const alreadySent = await checkIfEmailSent(jobId);
    if (alreadySent) {
      logger.info('Email already sent (idempotent skip)', {
        jobId,
        to: payload.to,
      });

      return {
        alreadySent: true,
        skipped: true,
      };
    }

    // Send email (simulated)
    await sendEmail(payload, jobId);

    // Mark as sent (for idempotency)
    await markEmailAsSent(jobId);

    const duration = Date.now() - startTime;

    logger.info('Email sent successfully', {
      jobId,
      to: payload.to,
      subject: payload.subject,
      duration,
    });

    return {
      sentAt: new Date().toISOString(),
      to: payload.to,
      subject: payload.subject,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Failed to send email', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
      duration,
    });

    throw error;
  }
}

/**
 * Validate email payload
 */
function validateEmailPayload(payload: Record<string, unknown>): EmailPayload {
  if (!payload.to || typeof payload.to !== 'string') {
    throw new Error('Email "to" field is required');
  }

  if (!payload.subject || typeof payload.subject !== 'string') {
    throw new Error('Email "subject" field is required');
  }

  if (!payload.body || typeof payload.body !== 'string') {
    throw new Error('Email "body" field is required');
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(payload.to)) {
    throw new Error('Invalid email address format');
  }

  return payload as unknown as EmailPayload;
}

/**
 * Check if email already sent (idempotency)
 *
 * In production: Check database or cache
 */
async function checkIfEmailSent(_jobId: string): Promise<boolean> {
  // TODO: Implement idempotency check
  // Example:
  // const record = await redis.get(`email:sent:${jobId}`);
  // return !!record;

  return false;
}

/**
 * Send email via email service
 *
 * In production: Integrate with SendGrid, AWS SES, etc.
 */
async function sendEmail(
  payload: EmailPayload,
  idempotencyKey: string
): Promise<void> {
  // Simulate email sending
  await new Promise((resolve) => setTimeout(resolve, 100));

  // TODO: Implement actual email sending
  // Example with SendGrid:
  // await sendgrid.send({
  //   to: payload.to,
  //   from: payload.from || 'noreply@taskflow.com',
  //   subject: payload.subject,
  //   text: payload.body,
  //   customArgs: {
  //     idempotencyKey,
  //   },
  // });

  logger.debug('Email sent (simulated)', {
    to: payload.to,
    subject: payload.subject,
    idempotencyKey,
  });
}

/**
 * Mark email as sent (idempotency)
 */
async function markEmailAsSent(jobId: string): Promise<void> {
  // TODO: Implement idempotency tracking
  // Example:
  // await redis.setex(`email:sent:${jobId}`, 86400, '1'); // 24h TTL

  logger.debug('Email marked as sent', { jobId });
}
