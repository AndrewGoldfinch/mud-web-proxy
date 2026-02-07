import { describe, it, expect } from 'bun:test';
import { TriggerMatcher } from '../src/trigger-matcher';

describe('TriggerMatcher', () => {
  describe('tell pattern matching', () => {
    it('should match basic tell', () => {
      const matcher = new TriggerMatcher();
      const result = matcher.match(
        'Soandso tells you: Hello there!',
        'test-session'
      );
      
      expect(result).not.toBeNull();
      expect(result?.triggerType).toBe('tell');
      expect(result?.extractedData?.['sender']).toBe('Soandso');
      expect(result?.extractedData?.['message']).toBe('Hello there!');
    });

    it('should match tell with group', () => {
      const matcher = new TriggerMatcher();
      const result = matcher.match(
        'Player tells the group: Help!',
        'test-session'
      );
      
      expect(result).not.toBeNull();
      expect(result?.triggerType).toBe('tell');
    });
  });

  describe('combat pattern matching', () => {
    it('should match attack initiation', () => {
      const matcher = new TriggerMatcher();
      const result = matcher.match(
        'Dragon attacks you!',
        'test-session'
      );
      
      expect(result).not.toBeNull();
      expect(result?.triggerType).toBe('combat');
    });
  });

  describe('death pattern matching', () => {
    it('should match death message', () => {
      const matcher = new TriggerMatcher();
      const result = matcher.match(
        'You have died.',
        'test-session'
      );
      
      expect(result).not.toBeNull();
      expect(result?.triggerType).toBe('death');
    });
  });

  describe('rate limiting', () => {
    it('should limit notifications per type per minute', () => {
      const matcher = new TriggerMatcher({
        rateLimit: {
          perTypePerMinute: 1,
          totalPerHour: 10,
        },
      });
      
      // First tell should match
      const result1 = matcher.match('Alice tells you: First', 'session-1');
      expect(result1).not.toBeNull();
      
      // Second tell within same minute should be rate limited
      const result2 = matcher.match('Bob tells you: Second', 'session-1');
      expect(result2).toBeNull();
    });
  });

  describe('custom triggers', () => {
    it('should add custom trigger', () => {
      const matcher = new TriggerMatcher();
      
      matcher.addTrigger({
        id: 'custom-1',
        type: 'custom',
        pattern: /ALERT: (.+)/i,
        enabled: true,
        label: 'Alert',
      });
      
      const result = matcher.match('ALERT: System failure!', 'test-session');
      expect(result).not.toBeNull();
      expect(result?.triggerId).toBe('custom-1');
    });

    it('should disable trigger', () => {
      const matcher = new TriggerMatcher();
      
      matcher.setTriggerEnabled('tell', false);
      
      const result = matcher.match('Alice tells you: Hello', 'test-session');
      expect(result).toBeNull();
    });
  });
});
