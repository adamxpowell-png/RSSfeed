import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, normaliseTitle, dedupeKeys } from './dedupe.js';

test('strips tracking params and www, forces https', () => {
  assert.equal(
    canonicalUrl('http://www.Example.com/story/one?utm_source=x&utm_medium=y&id=7#top'),
    'example.com/story/one?id=7'
  );
});

test('treats trailing slash and AMP variants as the same article', () => {
  const a = canonicalUrl('https://example.com/story/one/');
  const b = canonicalUrl('https://example.com/story/one/amp');
  assert.equal(a, b);
});

test('unwraps a Google Alerts redirect to the destination', () => {
  assert.equal(
    canonicalUrl('https://www.google.com/url?rct=j&sa=t&url=https://thisday.ng/nlng-story&ct=ga&cd=abc&usg=xyz'),
    'thisday.ng/nlng-story'
  );
});

test('unwraps a Bing News apiclick redirect', () => {
  assert.equal(
    canonicalUrl('https://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=123&url=https%3A%2F%2Fwww.shephardmedia.com%2Fnews%2Fsyos&c=1'),
    'shephardmedia.com/news/syos'
  );
});

test('refuses to treat an undecodable Google News link as an identity', () => {
  assert.equal(canonicalUrl('https://news.google.com/rss/articles/CBMiK0FVX3lxTE?oc=5'), null);
});

test('rejects non-http input', () => {
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl(''), null);
  assert.equal(canonicalUrl(undefined), null);
});

test('normalises headlines across outlet suffixes and year stamps', () => {
  const a = normaliseTitle('Hanwha Ocean deepens US ties and eyes Saudi submarine prospect - Shephard Media');
  const b = normaliseTitle('Hanwha Ocean deepens US ties and eyes Saudi submarine prospect');
  const c = normaliseTitle('Hanwha Ocean deepens US ties and eyes Saudi submarine prospect (2026)');
  assert.equal(a, b);
  assert.equal(c, b);
});

test('strips diacritics so Toruku and Toruku collide', () => {
  assert.equal(
    normaliseTitle('NLNG advances its Toruku transformation programme'),
    normaliseTitle('NLNG advances its Tórúkú transformation programme')
  );
});

test('short or generic titles produce no title key', () => {
  assert.equal(dedupeKeys({ url: 'https://example.com/a', title: 'Weekly roundup' }).titleKey, null);
});

test('same story via two different alert wrappers shares a url key', () => {
  const viaAlerts = dedupeKeys({
    url: 'https://www.google.com/url?url=https://example.com/nlng-train-7&usg=abc',
    title: 'NLNG confirms Train 7 progress at Bonny Island',
  });
  const viaBing = dedupeKeys({
    url: 'https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fexample.com%2Fnlng-train-7%3Futm_source%3Dbing&tid=9',
    title: 'NLNG confirms Train 7 progress at Bonny Island | Reuters',
  });
  assert.equal(viaAlerts.urlKey, viaBing.urlKey);
  assert.equal(viaAlerts.titleKey, viaBing.titleKey);
});

test('genuinely different stories do not collide', () => {
  const a = dedupeKeys({ url: 'https://example.com/one', title: 'NLNG confirms Train 7 progress at Bonny Island' });
  const b = dedupeKeys({ url: 'https://example.com/two', title: 'SYOS Aerospace wins Royal Navy trial contract' });
  assert.notEqual(a.urlKey, b.urlKey);
  assert.notEqual(a.titleKey, b.titleKey);
});
