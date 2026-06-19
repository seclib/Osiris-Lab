/**
 * OSIRIS Security Framework — Multi-Factor Authentication Enforcer
 * 
 * Implémente MFA avec 6 méthodes.
 * Supporte device trust et rate limiting.
 * 
 * Zero Trust: Always verify identity with multiple factors.
 */

import crypto from 'crypto';
import type { SecurityContext } from './types';

/**
 * MFA method type
 */
export type MFAMethod = 'totp' | 'sms' | 'email' | 'push' | 'webauthn' | 'backup_code';

/**
 * MFA challenge
 */
export interface MFAChallenge {
  id: string;
  userId: string;
  method: MFAMethod;
  code?: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  verified: boolean;
  createdAt: number;
}

/**
 * MFA verification result
 */
export interface MFAVerificationResult {
  success: boolean;
  error?: string;
  requiresMFA: boolean;
  challengeId?: string;
  trustedDevice?: boolean;
}

/**
 * MFA configuration
 */
export interface MFAConfig {
  challengeTTL: number;
  maxAttempts: number;
  deviceTrustDuration: number;
  rateLimitWindow: number;
  rateLimitMaxAttempts: number;
  backupCodeLength: number;
  totpPeriod: number;
  totpDigits: number;
}

/**
 * Default config
 */
const DEFAULT_CONFIG: MFAConfig = {
  challengeTTL: 5 * 60 * 1000, // 5 minutes
  maxAttempts: 3,
  deviceTrustDuration: 24 * 60 * 60 * 1000, // 24 hours
  rateLimitWindow: 60 * 1000, // 1 minute
  rateLimitMaxAttempts: 10,
  backupCodeLength: 10,
  totpPeriod: 30,
  totpDigits: 6,
};

/**
 * MFA attempt tracking (for rate limiting)
 */
interface MFAAttempt {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
}

/**
 * MFA Enforcer
 * 
 * Gère l'authentification multi-facteurs.
 * - 6 méthodes (TOTP, SMS, Email, Push, WebAuthn, Backup codes)
 * - Device trust (24h)
 * - Rate limiting (10 attempts/minute)
 * - Challenge expiration
 */
export class MFAEnforcer {
  private config: MFAConfig;
  private challenges: Map<string, MFAChallenge> = new Map();
  private userChallenges: Map<string, Set<string>> = new Map(); // userId -> Set<challengeId>
  private trustedDevices: Map<string, { userId: string; expiresAt: number }> = new Map();
  private mfaAttempts: Map<string, MFAAttempt> = new Map(); // key -> attempts

  constructor(config?: Partial<MFAConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create MFA challenge
   */
  async createChallenge(
    userId: string,
    method: MFAMethod,
    destination?: string
  ): Promise<MFAChallenge> {
    // Check rate limiting
    this.checkRateLimit(userId);

    const challenge: MFAChallenge = {
      id: this.generateChallengeId(),
      userId,
      method,
      expiresAt: Date.now() + this.config.challengeTTL,
      attempts: 0,
      maxAttempts: this.config.maxAttempts,
      verified: false,
      createdAt: Date.now(),
    };

    // Generate code based on method
    switch (method) {
      case 'totp':
        challenge.code = this.generateTOTP(userId);
        break;
      case 'sms':
      case 'email':
        challenge.code = this.generateNumericCode();
        // In production, send SMS/email here
        console.log(`[MFA] ${method} code for ${userId}: ${challenge.code} (to: ${destination})`);
        break;
      case 'push':
        challenge.code = this.generateNumericCode();
        // In production, send push notification here
        console.log(`[MFA] Push notification for ${userId}: ${challenge.code}`);
        break;
      case 'webauthn':
        challenge.code = this.generateNumericCode();
        // In production, initiate WebAuthn ceremony here
        console.log(`[MFA] WebAuthn challenge for ${userId}`);
        break;
      case 'backup_code':
        challenge.code = this.generateBackupCode();
        break;
    }

    // Store challenge
    this.challenges.set(challenge.id, challenge);

    // Update user index
    if (!this.userChallenges.has(userId)) {
      this.userChallenges.set(userId, new Set());
    }
    this.userChallenges.get(userId)!.add(challenge.id);

    return challenge;
  }

  /**
   * Verify MFA challenge
   */
  async verifyChallenge(challengeId: string, code: string): Promise<MFAVerificationResult> {
    const challenge = this.challenges.get(challengeId);

    if (!challenge) {
      return {
        success: false,
        error: 'Challenge not found',
        requiresMFA: true,
      };
    }

    // Check expiration
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return {
        success: false,
        error: 'Challenge expired',
        requiresMFA: true,
      };
    }

    // Check if already verified
    if (challenge.verified) {
      return {
        success: false,
        error: 'Challenge already used',
        requiresMFA: true,
      };
    }

    // Check max attempts
    if (challenge.attempts >= challenge.maxAttempts) {
      this.challenges.delete(challengeId);
      return {
        success: false,
        error: 'Max attempts exceeded',
        requiresMFA: true,
      };
    }

    // Increment attempts
    challenge.attempts++;
    this.challenges.set(challengeId, challenge);

    // Verify code
    const isValid = await this.verifyCode(challenge, code);

    if (isValid) {
      challenge.verified = true;
      this.challenges.set(challengeId, challenge);

      // Check if trusted device
      const deviceKey = `${challenge.userId}:device`;
      const trustedDevice = this.trustedDevices.has(deviceKey);

      if (!trustedDevice) {
        // Register trusted device
        this.trustedDevices.set(deviceKey, {
          userId: challenge.userId,
          expiresAt: Date.now() + this.config.deviceTrustDuration,
        });
      }

      return {
        success: true,
        requiresMFA: false,
        challengeId,
        trustedDevice,
      };
    }

    return {
      success: false,
      error: 'Invalid code',
      requiresMFA: true,
      challengeId,
    };
  }

  /**
   * Check if user has MFA enabled
   */
  async hasMFAEnabled(userId: string): Promise<boolean> {
    // In production, check database
    // For now, return true if user has any active challenge
    const userChallengeIds = this.userChallenges.get(userId);
    if (!userChallengeIds) return false;

    return Array.from(userChallengeIds).some((id) => {
      const challenge = this.challenges.get(id);
      return challenge && !challenge.verified;
    });
  }

  /**
   * Check if device is trusted
   */
  isTrustedDevice(userId: string, deviceId: string): boolean {
    const deviceKey = `${userId}:${deviceId}`;
    const device = this.trustedDevices.get(deviceKey);

    if (!device) return false;

    // Check expiration
    if (Date.now() > device.expiresAt) {
      this.trustedDevices.delete(deviceKey);
      return false;
    }

    return true;
  }

  /**
   * Revoke trusted device
   */
  revokeTrustedDevice(userId: string, deviceId: string): void {
    const deviceKey = `${userId}:${deviceId}`;
    this.trustedDevices.delete(deviceKey);
  }

  /**
   * Revoke all trusted devices for user
   */
  revokeAllTrustedDevices(userId: string): void {
    for (const [key] of this.trustedDevices) {
      if (key.startsWith(`${userId}:`)) {
        this.trustedDevices.delete(key);
      }
    }
  }

  /**
   * Check rate limiting
   */
  private checkRateLimit(userId: string): void {
    const key = `mfa:${userId}`;
    const now = Date.now();
    const attempt = this.mfaAttempts.get(key);

    if (attempt) {
      // Check if window has expired
      if (now - attempt.firstAttempt > this.config.rateLimitWindow) {
        this.mfaAttempts.delete(key);
        return;
      }

      // Check if max attempts exceeded
      if (attempt.count >= this.config.rateLimitMaxAttempts) {
        const timeSinceLastAttempt = now - attempt.lastAttempt;
        const retryAfter = this.config.rateLimitWindow - timeSinceLastAttempt;

        throw new Error(
          `Too many MFA attempts. Try again in ${Math.ceil(retryAfter / 1000)} seconds`
        );
      }

      // Update attempt
      attempt.count++;
      attempt.lastAttempt = now;
      this.mfaAttempts.set(key, attempt);
    } else {
      // First attempt
      this.mfaAttempts.set(key, {
        count: 1,
        firstAttempt: now,
        lastAttempt: now,
      });
    }
  }

  /**
   * Verify code based on method
   */
  private async verifyCode(challenge: MFAChallenge, code: string): Promise<boolean> {
    switch (challenge.method) {
      case 'totp':
        return this.verifyTOTP(challenge.userId, code);
      case 'sms':
      case 'email':
      case 'push':
      case 'backup_code':
        return code === challenge.code;
      case 'webauthn':
        // In production, verify WebAuthn assertion
        return code === challenge.code;
      default:
        return false;
    }
  }

  /**
   * Generate TOTP (Time-based One-Time Password)
   */
  private generateTOTP(userId: string): string {
    const secret = this.getTOTPSecret(userId);
    const time = Math.floor(Date.now() / 1000 / this.config.totpPeriod);
    
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(Buffer.from(time.toString(16).padStart(16, '0'), 'hex'));
    const digest = hmac.digest();
    
    const offset = digest[digest.length - 1] & 0x0f;
    const code = ((digest[offset] & 0x7f) << 24) |
                 ((digest[offset + 1] & 0xff) << 16) |
                 ((digest[offset + 2] & 0xff) << 8) |
                 (digest[offset + 3] & 0xff);
    
    const otp = (code % Math.pow(10, this.config.totpDigits)).toString().padStart(this.config.totpDigits, '0');
    return otp;
  }

  /**
   * Verify TOTP
   */
  private verifyTOTP(userId: string, code: string): boolean {
    const secret = this.getTOTPSecret(userId);
    const time = Math.floor(Date.now() / 1000 / this.config.totpPeriod);
    
    // Check current and previous time window
    for (let i = -1; i <= 1; i++) {
      const expectedCode = this.generateTOTPForTime(secret, time + i);
      if (expectedCode === code) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Generate TOTP for specific time
   */
  private generateTOTPForTime(secret: string, time: number): string {
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(Buffer.from(time.toString(16).padStart(16, '0'), 'hex'));
    const digest = hmac.digest();
    
    const offset = digest[digest.length - 1] & 0x0f;
    const code = ((digest[offset] & 0x7f) << 24) |
                 ((digest[offset + 1] & 0xff) << 16) |
                 ((digest[offset + 2] & 0xff) << 8) |
                 (digest[offset + 3] & 0xff);
    
    return (code % Math.pow(10, this.config.totpDigits)).toString().padStart(this.config.totpDigits, '0');
  }

  /**
   * Get TOTP secret for user
   */
  private getTOTPSecret(userId: string): string {
    // In production, fetch from database
    // For now, use deterministic secret based on userId
    return `OSIRIS_TOTP_SECRET_${userId}`;
  }

  /**
   * Generate numeric code (6 digits)
   */
  private generateNumericCode(): string {
    const bytes = new Uint8Array(3);
    crypto.getRandomValues(bytes);
    const code = ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 1000000;
    return code.toString().padStart(6, '0');
  }

  /**
   * Generate backup code
   */
  private generateBackupCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = new Uint8Array(this.config.backupCodeLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => chars[b % chars.length]).join('');
  }

  /**
   * Generate challenge ID
   */
  private generateChallengeId(): string {
    const timestamp = Date.now().toString(36);
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    const random = Array.from(randomBytes).map((b) => b.toString(36)).join('');
    return `mfa_${timestamp}_${random}`;
  }

  /**
   * Cleanup expired challenges
   */
  cleanupExpiredChallenges(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [challengeId, challenge] of this.challenges) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(challengeId);
        
        // Remove from user index
        const userChallengeIds = this.userChallenges.get(challenge.userId);
        if (userChallengeIds) {
          userChallengeIds.delete(challengeId);
        }
        
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Cleanup expired trusted devices
   */
  cleanupExpiredDevices(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, device] of this.trustedDevices) {
      if (now > device.expiresAt) {
        this.trustedDevices.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MFAConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): MFAConfig {
    return { ...this.config };
  }
}