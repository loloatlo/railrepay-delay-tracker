/**
 * Eligibility Engine Client
 *
 * HTTP client for communicating with the eligibility-engine service
 * Triggers compensation claims and checks eligibility
 */

import { ClaimTriggerApiResponse, EligibilityCheckResponse } from '../types.js';

interface EligibilityEngineClientConfig {
  baseUrl: string;
  timeout?: number;
}

interface TriggerClaimParams {
  delayAlertId: string;
  journeyId: string;
  userId: string;
  delayMinutes: number;
  delayReasons?: Record<string, unknown>;
}

interface CheckEligibilityParams {
  userId: string;
  journeyId: string;
  delayMinutes: number;
}

export class EligibilityEngineClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: EligibilityEngineClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Trigger a compensation claim
   */
  async triggerClaim(params: TriggerClaimParams): Promise<ClaimTriggerApiResponse> {
    const url = `${this.baseUrl}/api/v1/claims/trigger`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          delay_alert_id: params.delayAlertId,
          journey_id: params.journeyId,
          user_id: params.userId,
          delay_minutes: params.delayMinutes,
          delay_reasons: params.delayReasons,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: `API error: ${response.status} ${response.statusText}`,
          message: errorBody,
        };
      }

      return await response.json() as ClaimTriggerApiResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Eligibility API request timeout');
      }
      throw error;
    }
  }

  /**
   * Check if a claim is eligible
   */
  async checkEligibility(params: CheckEligibilityParams): Promise<EligibilityCheckResponse> {
    const url = `${this.baseUrl}/api/v1/eligibility/check`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: params.userId,
          journey_id: params.journeyId,
          delay_minutes: params.delayMinutes,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          eligible: false,
          reason: `API error: ${response.status}`,
        };
      }

      return await response.json() as EligibilityCheckResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Eligibility API request timeout');
      }
      throw error;
    }
  }
}
