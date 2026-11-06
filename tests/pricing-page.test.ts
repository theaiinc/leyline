import request from 'supertest';
import { hostedBilling } from './helpers/hosted-billing';
import { wantsPricingPage } from '../src/core/pricing-page';

describe('/v1/pricing in a browser', () => {
  it('apps get JSON; a browser gets the page; ?format=json forces JSON', async () => {
    const h = hostedBilling();
    const api = await request(h.app).get('/v1/pricing');
    expect(api.headers['content-type']).toMatch(/json/);
    expect(api.body.models).toBeDefined();
    const page = await request(h.app).get('/v1/pricing').set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    expect(page.headers['content-type']).toMatch(/html/);
    expect(page.text).toContain('<h1>API pricing</h1>');
    expect(page.text).toContain('Chat models');
    expect(page.headers.vary).toMatch(/Accept/);
    const forced = await request(h.app).get('/v1/pricing?format=json').set('Accept', 'text/html');
    expect(forced.headers['content-type']).toMatch(/json/);
  });

  it('decides by Accept order', () => {
    expect(wantsPricingPage('application/json, text/html', undefined)).toBe(false);
    expect(wantsPricingPage('*/*', undefined)).toBe(false);
    expect(wantsPricingPage(undefined, undefined)).toBe(false);
    expect(wantsPricingPage('text/html', undefined)).toBe(true);
    expect(wantsPricingPage('application/json', 'html')).toBe(true);
  });
});
