export type NotifyDecision = {
  decision: 'send' | 'skip'
  reason?: string
  intent_id?: string | null
  notification?: { title: string; body: string; action_url?: string; tag?: string; category?: string } | null
  evidence?: any
}

export async function requestNotificationDecision(input: { intent?: string; context?: any }): Promise<NotifyDecision | null> {
  try {
    const res = await fetch('/api/notify/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {})
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.payload ?? null;
  } catch {
    return null;
  }
}

export async function showLocalNotification(payload: NotifyDecision | null) {
  if (!payload || payload.decision !== 'send' || !payload.notification) return false;
  const { title, body, action_url, tag } = payload.notification;
  if (!('Notification' in window)) return false;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
    // Prefer SW when available
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title || '通知', {
          body: body || '', icon: '/FlexiStudy_icon.svg', badge: '/FlexiStudy_icon.svg',
          tag: tag || 'general', data: { url: action_url || '/' }, requireInteraction: false
        });
        return true;
      }
    } catch {}
    // Fallback to direct Notification
    new Notification(title || '通知', { body: body || '' });
    return true;
  } catch {
    return false;
  }
}

