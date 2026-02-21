import { describe, it, expect } from 'bun:test';
import { BackgroundPushScheduler } from '../src/background-push-scheduler';
import { Session } from '../src/session';
import type { ActivityContentState } from '../src/types';

class MockPushNotifier {
  silentCalls: Array<{ deviceToken: string; sessionId: string }> = [];
  activityCalls: Array<{
    token: string;
    contentState: ActivityContentState;
  }> = [];

  async sendSilentPush(deviceToken: string, sessionId: string): Promise<boolean> {
    this.silentCalls.push({ deviceToken, sessionId });
    return true;
  }

  async sendActivityKitPush(
    token: string,
    contentState: ActivityContentState,
  ): Promise<boolean> {
    this.activityCalls.push({ token, contentState });
    return true;
  }
}

describe('BackgroundPushScheduler', () => {
  it('tracks and untracks sessions', async () => {
    const notifier = new MockPushNotifier();
    const scheduler = new BackgroundPushScheduler(notifier as never);
    const session = new Session('mud.example.com', 4000);
    session.deviceToken = 'dev-1';

    scheduler.trackSession(session);
    scheduler.untrackSession(session.id);

    await scheduler.onBufferedOutput(session, 1, 'hello');
    expect(notifier.silentCalls.length).toBe(0);
  });

  it('throttles silent pushes per session', async () => {
    const notifier = new MockPushNotifier();
    const scheduler = new BackgroundPushScheduler(notifier as never, {
      silentPushIntervalMs: 60_000,
      activityPushIntervalMs: 60_000,
    });
    const session = new Session('mud.example.com', 4000);
    session.deviceToken = 'dev-1';
    session.markClientBackgrounded();
    scheduler.trackSession(session);

    await scheduler.onBufferedOutput(session, 1, 'first');
    await scheduler.onBufferedOutput(session, 2, 'second');

    expect(notifier.silentCalls.length).toBe(1);
  });

  it('throttles activity pushes per session', async () => {
    const notifier = new MockPushNotifier();
    const scheduler = new BackgroundPushScheduler(notifier as never, {
      silentPushIntervalMs: 60_000,
      activityPushIntervalMs: 60_000,
    });
    const session = new Session('mud.example.com', 4000);
    session.activityPushToken = 'act-1';
    session.markClientBackgrounded();
    scheduler.trackSession(session);

    await scheduler.onBufferedOutput(session, 1, 'first');
    await scheduler.onBufferedOutput(session, 2, 'second');

    expect(notifier.activityCalls.length).toBe(1);
  });

  it('does not push when sequence has no new data', async () => {
    const notifier = new MockPushNotifier();
    const scheduler = new BackgroundPushScheduler(notifier as never);
    const session = new Session('mud.example.com', 4000);
    session.deviceToken = 'dev-1';
    session.activityPushToken = 'act-1';
    session.markClientBackgrounded();
    scheduler.trackSession(session);

    await scheduler.onBufferedOutput(session, 5, 'first');
    await scheduler.onBufferedOutput(session, 5, 'duplicate');

    expect(notifier.silentCalls.length).toBe(1);
    expect(notifier.activityCalls.length).toBe(1);
  });

  it('coalesces activity snippets to max length', async () => {
    const notifier = new MockPushNotifier();
    const scheduler = new BackgroundPushScheduler(notifier as never, {
      maxSnippetLength: 12,
      activityPushIntervalMs: 0,
      silentPushIntervalMs: 60_000,
    });
    const session = new Session('mud.example.com', 4000);
    session.activityPushToken = 'act-1';
    session.markClientBackgrounded();
    scheduler.trackSession(session);

    await scheduler.onBufferedOutput(session, 1, '  one   two   three   four  ');

    expect(notifier.activityCalls.length).toBe(1);
    expect(notifier.activityCalls[0]?.contentState.lastOutputSnippet).toBe(
      'one two thre',
    );
  });
});
