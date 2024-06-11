import http from 'node:http'
import { once } from 'node:events'
import assert from 'node:assert'
import pg from 'pg'
import createDebug from 'debug'
import { mapParticipantsToIds } from 'spark-evaluate/lib/platform-stats.js'

import { assertResponseStatus } from './test-helpers.js'
import { createHandler } from '../lib/handler.js'
import { today } from '../lib/request-helpers.js'
import { EVALUATE_DB_URL } from '../lib/config.js'

const debug = createDebug('test')

describe('HTTP request handler', () => {
  /** @type {pg.Pool} */
  let pgPool
  /** @type {http.Server} */
  let server
  /** @type {string} */
  let baseUrl

  before(async () => {
    // handler doesn't use Stats DB
    pgPool = new pg.Pool({ connectionString: EVALUATE_DB_URL })

    const handler = createHandler({
      pgPoolEvaluateDb: pgPool,
      pgPoolStatsDb: undefined,
      logger: {
        info: debug,
        error: console.error,
        request: debug
      }
    })

    server = http.createServer(handler)
    server.listen()
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    server.closeAllConnections()
    server.close()
    await pgPool.end()
  })

  beforeEach(async () => {
    await pgPool.query('DELETE FROM retrieval_stats')
    await pgPool.query('DELETE FROM daily_participants')
  })

  it('returns 200 for GET /', async () => {
    const res = await fetch(new URL('/', baseUrl))
    await assertResponseStatus(res, 200)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(new URL('/unknown-path', baseUrl))
    await assertResponseStatus(res, 404)
  })

  it('returns 404 when the path starts with double slash', async () => {
    const res = await fetch(`${baseUrl}//path-not-found`)
    await assertResponseStatus(res, 404)
  })

  describe('GET /retrieval-success-rate', () => {
    beforeEach(async () => {
      await pgPool.query('DELETE FROM retrieval_stats')
    })

    it('returns today stats for no query string', async () => {
      const day = today()
      await givenRetrievalStats(pgPool, { day, total: 10, successful: 1 })
      const res = await fetch(new URL('/retrieval-success-rate', baseUrl), { redirect: 'follow' })
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { day, success_rate: 0.1, successful: '1', total: '10' }
      ])
    })

    it('applies from & to in YYYY-MM-DD format', async () => {
      await givenRetrievalStats(pgPool, { day: '2024-01-10', total: 10, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-11', total: 20, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-12', total: 30, successful: 3 })
      await givenRetrievalStats(pgPool, { day: '2024-01-13', total: 40, successful: 1 })

      const res = await fetch(
        new URL(
          '/retrieval-success-rate?from=2024-01-11&to=2024-01-12',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { day: '2024-01-11', success_rate: 0.05, successful: '1', total: '20' },
        { day: '2024-01-12', success_rate: 0.1, successful: '3', total: '30' }
      ])
    })

    it('redirects when from & to is in YYYY-MM-DDThh:mm:ss.sssZ format', async () => {
      const res = await fetch(
        new URL(
          '/retrieval-success-rate?from=2024-01-10T13:44:44.289Z&to=2024-01-15T09:44:44.289Z',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 301)
      assert.strictEqual(
        res.headers.get('location'),
        '/retrieval-success-rate?from=2024-01-10&to=2024-01-15'
      )
    })

    it('caches data including today for short time', async () => {
      const res = await fetch(
        new URL(`/retrieval-success-rate?from=2024-01-01&to=${today()}`, baseUrl),
        {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=600')
    })

    it('caches historical including for long time & marks them immutable', async () => {
      const res = await fetch(
        new URL('/retrieval-success-rate?from=2023-01-01&to=2023-12-31', baseUrl),
        {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    })

    it('sums daily retrievals from all miners', async () => {
      await givenRetrievalStats(pgPool, { day: '2024-01-10', minerId: 'f1one', total: 10, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-10', minerId: 'f1two', total: 100, successful: 50 })
      await givenRetrievalStats(pgPool, { day: '2024-01-11', minerId: 'f1one', total: 20, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-11', minerId: 'f1two', total: 200, successful: 60 })

      const res = await fetch(
        new URL(
          '/retrieval-success-rate?from=2024-01-10&to=2024-01-11',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      /** @type {{ day: string, success_rate: number }[]} */
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { day: '2024-01-10', success_rate: 51 / 110, total: '110', successful: '51' },
        { day: '2024-01-11', success_rate: 61 / 220, total: '220', successful: '61' }
      ])
    })

    it('sorts items by date ascending', async () => {
      await givenRetrievalStats(pgPool, { day: '2024-01-20', total: 10, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-10', total: 10, successful: 5 })

      const res = await fetch(
        new URL(
          '/retrieval-success-rate?from=2024-01-01&to=2024-01-31',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      /** @type {{ day: string, success_rate: number }[]} */
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { day: '2024-01-10', success_rate: 5 / 10, total: '10', successful: '5' },
        { day: '2024-01-20', success_rate: 1 / 10, total: '10', successful: '1' }
      ])
    })
  })

  describe('GET /participants/daily', () => {
    it('returns daily active participants for the given date range', async () => {
      await givenDailyParticipants(pgPool, '2024-01-10', ['0x10', '0x20'])
      await givenDailyParticipants(pgPool, '2024-01-11', ['0x10', '0x20', '0x30'])
      await givenDailyParticipants(pgPool, '2024-01-12', ['0x10', '0x20', '0x40', '0x50'])
      await givenDailyParticipants(pgPool, '2024-01-13', ['0x10'])

      const res = await fetch(
        new URL(
          '/participants/daily?from=2024-01-11&to=2024-01-12',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { day: '2024-01-11', participants: 3 },
        { day: '2024-01-12', participants: 4 }
      ])
    })
  })

  describe('GET /participants/monthly', () => {
    it('returns monthly active participants for the given date range ignoring the day number', async () => {
      // before the range
      await givenDailyParticipants(pgPool, '2023-12-31', ['0x01', '0x02'])
      // in the range
      await givenDailyParticipants(pgPool, '2024-01-10', ['0x10', '0x20'])
      await givenDailyParticipants(pgPool, '2024-01-11', ['0x10', '0x20', '0x30'])
      await givenDailyParticipants(pgPool, '2024-01-12', ['0x10', '0x20', '0x40', '0x50'])
      await givenDailyParticipants(pgPool, '2024-02-13', ['0x10', '0x60'])
      // after the range
      await givenDailyParticipants(pgPool, '2024-03-01', ['0x99'])

      const res = await fetch(
        new URL(
          '/participants/monthly?from=2024-01-12&to=2024-02-12',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { month: '2024-01-01', participants: 5 },
        { month: '2024-02-01', participants: 2 }
      ])
    })
  })

  describe('GET /participants/change-rates', () => {
    it('returns monthly change rates for the given date range ignoring the day number', async () => {
      // before the range
      await givenDailyParticipants(pgPool, '2023-12-31', ['0x01', '0x02'])
      // the last month before the range
      await givenDailyParticipants(pgPool, '2024-01-10', ['0x10', '0x20'])
      await givenDailyParticipants(pgPool, '2024-01-11', ['0x10', '0x20', '0x30'])
      await givenDailyParticipants(pgPool, '2024-01-12', ['0x10', '0x20', '0x40', '0x50'])
      // the first month in the range - 0x50 is gone
      await givenDailyParticipants(pgPool, '2024-02-11', ['0x10', '0x20'])
      await givenDailyParticipants(pgPool, '2024-02-13', ['0x20', '0x30', '0x40'])
      // the second month in the range - 0x30 and 0x40 is gone, new participant 0x60
      await givenDailyParticipants(pgPool, '2024-03-11', ['0x10', '0x20'])
      await givenDailyParticipants(pgPool, '2024-03-13', ['0x10', '0x60'])
      // after the range
      await givenDailyParticipants(pgPool, '2024-04-01', ['0x99'])

      const res = await fetch(
        new URL(
          '/participants/change-rates?from=2024-02-28&to=2024-03-01',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        // January: 5 participants
        // February: 1 participant lost, no new participants
        {
          month: '2024-02-01',
          // Churn: 1/5 = 20%
          churnRate: 0.2,
          // Growth: 0/5 = 20%
          growthRate: 0,
          // Retention: 4/5 = 80%
          retentionRate: 0.8
        },
        // February: 4 participants
        // March: 2 participants lost, 1 new participant
        {
          month: '2024-03-01',
          // Churn: 2/4 = 50%
          churnRate: 0.5,
          // Growth: 1/4 = 25%
          growthRate: 0.25,
          // Retention: 2/4 = 50%
          retentionRate: 0.5
        }
      ])
    })

    it('handles a single-month range', async () => {
      // the last month before the range
      await givenDailyParticipants(pgPool, '2024-01-10', ['0x10', '0x20'])
      // the only month in the range - 0x20 is gone
      await givenDailyParticipants(pgPool, '2024-02-11', ['0x10'])
      // after the range
      await givenDailyParticipants(pgPool, '2024-03-01', ['0x99'])

      const res = await fetch(
        new URL(
          '/participants/change-rates?from=2024-02-11&to=2024-02-11',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [{
        month: '2024-02-01',
        churnRate: 0.5,
        growthRate: 0,
        retentionRate: 0.5
      }])
    })
  })

  describe('GET /miners/retrieval-success-rate/summary', () => {
    it('returns a summary of miners RSR for the given date range', async () => {
      // before the range
      await givenRetrievalStats(pgPool, { day: '2024-01-10', minerId: 'f1one', total: 10, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-10', minerId: 'f1two', total: 100, successful: 20 })
      // in the range
      await givenRetrievalStats(pgPool, { day: '2024-01-11', minerId: 'f1one', total: 20, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-11', minerId: 'f1two', total: 200, successful: 150 })
      // after the range
      await givenRetrievalStats(pgPool, { day: '2024-01-12', minerId: 'f1one', total: 30, successful: 1 })
      await givenRetrievalStats(pgPool, { day: '2024-01-12', minerId: 'f1two', total: 300, successful: 60 })

      const res = await fetch(
        new URL(
          '/miners/retrieval-success-rate/summary?from=2024-01-11&to=2024-01-11',
          baseUrl
        ), {
          redirect: 'manual'
        }
      )
      await assertResponseStatus(res, 200)
      const stats = await res.json()
      assert.deepStrictEqual(stats, [
        { miner_id: 'f1one', success_rate: 0.05, total: '20', successful: '1' },
        { miner_id: 'f1two', success_rate: 0.75, total: '200', successful: '150' }
      ])
    })
  })
})

const givenRetrievalStats = async (pgPool, { day, minerId, total, successful }) => {
  await pgPool.query(
    'INSERT INTO retrieval_stats (day, miner_id, total, successful) VALUES ($1, $2, $3, $4)',
    [day, minerId ?? 'f1test', total, successful]
  )
}

const givenDailyParticipants = async (pgPool, day, participantAddresses) => {
  const ids = await mapParticipantsToIds(pgPool, new Set(participantAddresses))
  await pgPool.query(`
    INSERT INTO daily_participants (day, participant_id)
    SELECT $1 as day, UNNEST($2::INT[]) AS participant_id
    ON CONFLICT DO NOTHING
  `, [
    day,
    ids
  ])
}
