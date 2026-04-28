import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCaptureMetadata, parseListOutput, validateSessionName } from './tmux.js'

describe('tmux', () => {
    it('parses list-sessions output', () => {
        const out = [
            'main\t3\t1\t1700000000\t1700000500',
            'work\t1\t0\t1700001000\t1700001200'
        ].join('\n')
        const list = parseListOutput(out)
        assert.equal(list.length, 2)
        assert.deepEqual(list[0], {
            name: 'main',
            windows: 3,
            attached: true,
            created: 1700000000,
            activity: 1700000500
        })
        assert.equal(list[1].attached, false)
    })

    it('ignores blank lines', () => {
        assert.equal(parseListOutput('\n\n').length, 0)
    })

    it('ignores malformed rows', () => {
        assert.equal(parseListOutput('oops').length, 0)
    })

    it('validateSessionName rejects bad names', () => {
        assert.throws(() => validateSessionName('bad name'))
        assert.throws(() => validateSessionName('semicolon;rm'))
        assert.throws(() => validateSessionName(''))
    })

    it('validateSessionName accepts good names', () => {
        assert.equal(validateSessionName('main'), 'main')
        assert.equal(validateSessionName('my-session.1_test'), 'my-session.1_test')
    })

    it('parses capture metadata outside copy mode', () => {
        assert.deepEqual(parseCaptureMetadata('0\t\t1804\t31\n'), {
            paneInMode: false,
            scrollPosition: 0,
            historySize: 1804,
            paneHeight: 31
        })
    })

    it('parses capture metadata inside copy mode', () => {
        assert.deepEqual(parseCaptureMetadata('1\t20\t1804\t31\n'), {
            paneInMode: true,
            scrollPosition: 20,
            historySize: 1804,
            paneHeight: 31
        })
    })
})
