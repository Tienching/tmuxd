import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    isEmptyTmuxWorld,
    parseCaptureMetadata,
    parseListOutput,
    parsePaneListOutput,
    truncateUtf8,
    validatePaneTarget,
    validateSessionName,
    validateTmuxKey
} from './tmux.js'

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
            attachedClients: 1,
            created: 1700000000,
            activity: 1700000500
        })
        assert.equal(list[1].attached, false)
        assert.equal(list[1].attachedClients, 0)
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

    it('validatePaneTarget accepts constrained tmux targets', () => {
        assert.equal(validatePaneTarget('main'), 'main')
        assert.equal(validatePaneTarget('main:0'), 'main:0')
        assert.equal(validatePaneTarget('main:0.1'), 'main:0.1')
        assert.equal(validatePaneTarget('%1'), '%1')
    })

    it('validatePaneTarget rejects shell-ish targets', () => {
        assert.throws(() => validatePaneTarget('main;rm'))
        assert.throws(() => validatePaneTarget('%abc'))
        assert.equal(validatePaneTarget('bad target'), 'bad target')
    })

    it('validateTmuxKey accepts special key names and rejects separators', () => {
        assert.equal(validateTmuxKey('Enter'), 'Enter')
        assert.equal(validateTmuxKey('C-c'), 'C-c')
        assert.throws(() => validateTmuxKey('-t'))
        assert.throws(() => validateTmuxKey('C-c;rm'))
    })

    it('parses list-panes output', () => {
        const out = [
            [
                'main',
                '0',
                'zsh',
                '1',
                '2',
                '%5',
                '1',
                '0',
                'bash',
                '/home/ubuntu',
                'title',
                '120',
                '40',
                '0',
                '',
                '2000',
                '2',
                '1700000500',
                '1700000600'
            ].join('\t')
        ].join('\n')
        assert.deepEqual(parsePaneListOutput(out), [
            {
                target: 'main:0.2',
                sessionName: 'main',
                windowIndex: 0,
                windowName: 'zsh',
                windowActive: true,
                paneIndex: 2,
                paneId: '%5',
                paneActive: true,
                paneDead: false,
                currentCommand: 'bash',
                currentPath: '/home/ubuntu',
                title: 'title',
                width: 120,
                height: 40,
                paneInMode: false,
                scrollPosition: 0,
                historySize: 2000,
                sessionAttached: true,
                sessionAttachedClients: 2,
                sessionActivity: 1700000500,
                windowActivity: 1700000600
            }
        ])
    })

    it('parses older list-panes output with default activity metadata', () => {
        const out = [
            [
                'main',
                '0',
                'zsh',
                '1',
                '0',
                '%5',
                '1',
                '0',
                'bash',
                '/home/ubuntu',
                'title',
                '120',
                '40',
                '0',
                '0',
                '2000'
            ].join('\t')
        ].join('\n')
        const [pane] = parsePaneListOutput(out)
        assert.equal(pane.sessionAttached, false)
        assert.equal(pane.sessionAttachedClients, 0)
        assert.equal(pane.sessionActivity, 0)
        assert.equal(pane.windowActivity, 0)
    })

    it('parses list-panes output with tabs and newlines inside string fields', () => {
        const field = '\x1f'
        const record = '\x1e'
        const out = [
            'main',
            '0',
            'tab\twindow',
            '1',
            '0',
            '%5',
            '1',
            '0',
            'bash',
            '/home/ubuntu/with\ttab',
            'title\ncontinued',
            '120',
            '40',
            '0',
            '0',
            '2000',
            '0',
            '1700000500',
            '1700000600'
        ].join(field) + record + '\n'

        const [pane] = parsePaneListOutput(out)
        assert.equal(pane.windowName, 'tab\twindow')
        assert.equal(pane.currentPath, '/home/ubuntu/with\ttab')
        assert.equal(pane.title, 'title\ncontinued')
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

    it('truncates UTF-8 captures from the newest tail without splitting surrogate pairs', () => {
        const result = truncateUtf8(`older-${'🚀'.repeat(100)}-newest`, 19)
        assert.equal(result.truncated, true)
        assert.ok(Buffer.byteLength(result.text, 'utf8') <= 19)
        assert.ok(result.text.endsWith('-newest'))
        assertNoUnpairedSurrogates(result.text)
    })
})

function assertNoUnpairedSurrogates(value: string): void {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1)
            assert.ok(next >= 0xdc00 && next <= 0xdfff, `high surrogate at ${i} is not paired`)
            i++
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            assert.fail(`low surrogate at ${i} is unpaired`)
        }
    }
}

describe('isEmptyTmuxWorld', () => {
    it('treats "no server running" as empty', () => {
        assert.equal(isEmptyTmuxWorld(new Error('no server running on /tmp/tmux-1000/default')), true)
    })

    it('treats "no sessions" as empty', () => {
        assert.equal(isEmptyTmuxWorld(new Error('no sessions')), true)
    })

    it('treats socket-missing as empty (No such file or directory)', () => {
        // This is the failure mode that bit e2e-cli on a fresh TMUX_TMPDIR.
        const msg = 'Command failed: tmux list-sessions\nerror connecting to /tmp/tmux-500/default (No such file or directory)\n'
        assert.equal(isEmptyTmuxWorld(new Error(msg)), true)
    })

    it('does NOT swallow socket-permission errors', () => {
        // A genuine permission error means the operator misconfigured the
        // socket — surfacing it as 500 is correct, swallowing it as []
        // would silently mask the misconfiguration. This is the
        // negative-mutation test the security review asked for.
        const msg = 'Command failed: tmux list-sessions\nerror connecting to /tmp/tmux-1000/default (Permission denied)\n'
        assert.equal(isEmptyTmuxWorld(new Error(msg)), false)
    })

    it('does NOT swallow generic execFile failures', () => {
        assert.equal(isEmptyTmuxWorld(new Error('ENOENT: no such file: tmux')), false)
        assert.equal(isEmptyTmuxWorld(new Error('Command failed: tmux foo: unknown command')), false)
    })

    it('handles non-Error throws defensively', () => {
        assert.equal(isEmptyTmuxWorld('no server running'), true)
        assert.equal(isEmptyTmuxWorld(undefined), false)
        assert.equal(isEmptyTmuxWorld(null), false)
    })
})

describe('isEmptyTmuxWorld', () => {
    it('treats "no server running" as empty', () => {
        assert.equal(isEmptyTmuxWorld(new Error('no server running on /tmp/tmux-1000/default')), true)
    })

    it('treats "no sessions" as empty', () => {
        assert.equal(isEmptyTmuxWorld(new Error('no sessions')), true)
    })

    it('treats socket-missing as empty (No such file or directory)', () => {
        // This is the failure mode that bit e2e-cli on a fresh TMUX_TMPDIR.
        const msg = 'Command failed: tmux list-sessions\nerror connecting to /tmp/tmux-500/default (No such file or directory)\n'
        assert.equal(isEmptyTmuxWorld(new Error(msg)), true)
    })

    it('does NOT swallow socket-permission errors', () => {
        // A genuine permission error means the operator misconfigured the
        // socket — surfacing it as 500 is correct, swallowing it as []
        // would silently mask the misconfiguration. This is the
        // negative-mutation test the security review asked for.
        const msg = 'Command failed: tmux list-sessions\nerror connecting to /tmp/tmux-1000/default (Permission denied)\n'
        assert.equal(isEmptyTmuxWorld(new Error(msg)), false)
    })

    it('does NOT swallow generic execFile failures', () => {
        assert.equal(isEmptyTmuxWorld(new Error('ENOENT: no such file: tmux')), false)
        assert.equal(isEmptyTmuxWorld(new Error('Command failed: tmux foo: unknown command')), false)
    })

    it('handles non-Error throws defensively', () => {
        assert.equal(isEmptyTmuxWorld('no server running'), true)
        assert.equal(isEmptyTmuxWorld(undefined), false)
        assert.equal(isEmptyTmuxWorld(null), false)
    })
})
