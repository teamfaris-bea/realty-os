// The brokerage's own "Chat with us" link (<a href="#realty-chat-open">, module 37) opens the chat every time it is
// followed (findings F6, UXA-4): the widget takes the request off the page address once it has opened the chat, so
// the next click on the same link is a real address change again. Arriving with the request in the address (a link
// a team shared) opens it too.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_HASH, watchOpenHash } from './openHash.js';

const hashChange = async () => {
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await Promise.resolve();
};

afterEach(() => {
  history.replaceState(null, '', '/');
});

describe('#realty-chat-open (findings F6, UXA-4)', () => {
  it('the site\'s link opens the chat on every click, not only the first: the request is taken off the address once the chat opened', async () => {
    history.replaceState(null, '', '/listings?city=charleston');
    const open = vi.fn();
    const stop = watchOpenHash(open, window);
    expect(open).not.toHaveBeenCalled();
    for (let click = 1; click <= 3; click++) {
      location.hash = OPEN_HASH;
      await hashChange();
      expect(open).toHaveBeenCalledTimes(click);
      // the page itself stays where it was (path and query), with no request left in its address
      expect([location.pathname, location.search, location.hash]).toEqual(['/listings', '?city=charleston', '']);
    }
    // any other fragment is the site's own business
    location.hash = '#listings';
    await hashChange();
    expect(open).toHaveBeenCalledTimes(3);
    stop();
  });

  it('arriving with the request in the address opens the chat at once, and the site\'s link still works afterwards', async () => {
    history.replaceState(null, '', `/about${OPEN_HASH}`);
    const open = vi.fn();
    const stop = watchOpenHash(open, window);
    expect(open).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('');
    location.hash = OPEN_HASH;
    await hashChange();
    expect(open).toHaveBeenCalledTimes(2);
    stop();
  });
});
