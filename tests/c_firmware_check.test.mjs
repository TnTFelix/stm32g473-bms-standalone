import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cfg from '../sim/bms_config.mjs';
import * as types from '../sim/bms_types.mjs';
import * as halMock from '../sim/hal_mock.mjs';
import * as ina226 from '../sim/drivers/ina226.mjs';
import * as vsense from '../sim/drivers/voltage_sensor.mjs';
import * as estimator from '../sim/core/bms_estimator.mjs';
import * as stateMachine from '../sim/core/bms_state_machine.mjs';
import * as relayCtrl from '../sim/drivers/relay_ctrl.mjs';
import * as protection from '../sim/core/bms_protection.mjs';
import * as oledDrv from '../sim/drivers/ssd1309_oled.mjs';
import * as bmsApp from '../sim/app/bms_app.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readNormalized(relPath) {
    const absPath = join(ROOT, relPath);
    let text = readFileSync(absPath, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
    }
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\\\n/g, '');
    return text;
}

function collectFiles(dirRel, extFilter) {
    const absDir = join(ROOT, dirRel);
    const out = [];
    if (!existsSync(absDir)) {
        return out;
    }
    for (const entry of readdirSync(absDir)) {
        const full = join(absDir, entry);
        const rel = relative(ROOT, full).replace(/\\/g, '/');
        const st = statSync(full);
        if (st.isDirectory()) {
            out.push(...collectFiles(rel, extFilter));
        } else if (!extFilter || extFilter(rel)) {
            out.push(rel);
        }
    }
    return out;
}

function lexC(src) {
    const chars = src.split('');
    const n = chars.length;
    let i = 0;

    while (i < n) {
        const ch = chars[i];
        const next = i + 1 < n ? chars[i + 1] : '';

        if (ch === '/' && next === '/') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            while (i < n && chars[i] !== '\n') {
                chars[i] = ' ';
                i++;
            }
            continue;
        }

        if (ch === '/' && next === '*') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            while (i < n) {
                if (chars[i] === '*' && i + 1 < n && chars[i + 1] === '/') {
                    chars[i] = ' ';
                    chars[i + 1] = ' ';
                    i += 2;
                    break;
                }
                if (chars[i] !== '\n') {
                    chars[i] = ' ';
                }
                i++;
            }
            continue;
        }

        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            while (i < n) {
                if (chars[i] === '\\' && i + 1 < n) {
                    if (chars[i] !== '\n') chars[i] = ' ';
                    if (chars[i + 1] !== '\n') chars[i + 1] = ' ';
                    i += 2;
                    continue;
                }
                if (chars[i] === quote) {
                    i++;
                    break;
                }
                if (chars[i] !== '\n') {
                    chars[i] = ' ';
                }
                i++;
            }
            continue;
        }

        i++;
    }

    return chars.join('');
}

function blankPreprocessor(src) {
    return src
        .split('\n')
        .map((line) => (/^\s*#/.test(line) ? ' '.repeat(line.length) : line))
        .join('\n');
}

function tokenizeCExpr(expr) {
    const tokens = [];
    let i = 0;
    const n = expr.length;

    while (i < n) {
        const ch = expr[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '(' || ch === ')' || ch === '|' || ch === '-') {
            tokens.push(ch);
            i++;
            continue;
        }
        if (ch === '<' && expr[i + 1] === '<') {
            tokens.push('<<');
            i += 2;
            continue;
        }
        if (/[0-9.]/.test(ch)) {
            const rest = expr.slice(i);
            const m = rest.match(/^(0[xX][0-9a-fA-F]+|\d+\.\d*|\.\d+|\d+)([uUlLfF]*)/);
            if (!m) {
                throw new Error(`Invalid numeric literal in expression: "${expr}"`);
            }
            const rawNum = m[1];
            const suffix = m[2];
            let val;
            if (/^0[xX]/.test(rawNum)) {
                val = parseInt(rawNum, 16);
            } else if (rawNum.includes('.') || /[fF]/.test(suffix)) {
                val = parseFloat(rawNum);
            } else {
                val = parseInt(rawNum, 10);
            }
            tokens.push({ type: 'num', value: val });
            i += m[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            const rest = expr.slice(i);
            const m = rest.match(/^[A-Za-z_]\w*/);
            tokens.push({ type: 'ident', value: m[0] });
            i += m[0].length;
            continue;
        }
        throw new Error(`Unexpected character "${ch}" in C expression: "${expr}"`);
    }

    return tokens;
}

function evalCExpr(expr, symbols) {
    const tokens = tokenizeCExpr(expr);
    let pos = 0;

    function peek() {
        return pos < tokens.length ? tokens[pos] : null;
    }

    function consume() {
        const t = tokens[pos];
        pos++;
        return t;
    }

    function parseOr() {
        let left = parseShift();
        while (peek() === '|') {
            consume();
            const right = parseShift();
            left = Number(BigInt(left) | BigInt(right));
        }
        return left;
    }

    function parseShift() {
        let left = parseUnary();
        while (peek() === '<<') {
            consume();
            const right = parseUnary();
            if (!Number.isInteger(right) || right < 0 || right > 31) {
                throw new Error(`Invalid shift amount ${right} in expression "${expr}"`);
            }
            left = left * (2 ** right);
        }
        return left;
    }

    function parseUnary() {
        if (peek() === '-') {
            consume();
            return -parseUnary();
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const t = peek();
        if (t === null) {
            throw new Error(`Unexpected end of expression "${expr}"`);
        }
        if (t === '(') {
            consume();
            const v = parseOr();
            if (consume() !== ')') {
                throw new Error(`Missing closing ')' in expression "${expr}"`);
            }
            return v;
        }
        if (typeof t === 'object' && t.type === 'num') {
            consume();
            return t.value;
        }
        if (typeof t === 'object' && t.type === 'ident') {
            consume();
            if (!symbols.has(t.value)) {
                throw new Error(`Undefined symbol "${t.value}" in expression "${expr}"`);
            }
            return symbols.get(t.value);
        }
        throw new Error(`Unexpected token ${JSON.stringify(t)} in expression "${expr}"`);
    }

    const result = parseOr();
    if (pos !== tokens.length) {
        throw new Error(`Trailing tokens in expression "${expr}"`);
    }
    return result;
}

function parseDefines(src) {
    const lexed = lexC(src);
    const map = new Map();
    const lines = lexed.split('\n');
    const defRe = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\()\s+(.+)$/;

    for (const line of lines) {
        const m = line.match(defRe);
        if (!m) continue;
        const name = m[1];
        const expr = m[2].trim();
        if (!expr) continue;
        const val = evalCExpr(expr, map);
        map.set(name, val);
    }
    return map;
}

function parseEnumsDetailed(src, initialSymbols = new Map()) {
    const lexed = blankPreprocessor(lexC(src));
    const symbols = new Map(initialSymbols);
    const allMembers = new Map();
    const groups = new Map();
    const enumRe = /typedef\s+enum\s*(?:[A-Za-z_]\w*)?\s*\{([^}]*)\}\s*([A-Za-z_]\w*)\s*;/g;

    let m;
    while ((m = enumRe.exec(lexed)) !== null) {
        const body = m[1];
        const typeName = m[2];
        const groupMap = new Map();
        const items = body.split(',').map((s) => s.trim()).filter(Boolean);

        for (const item of items) {
            const eqIdx = item.indexOf('=');
            if (eqIdx === -1) {
                throw new Error(`Enum member "${item}" in ${typeName} is missing explicit '= value'`);
            }
            const name = item.slice(0, eqIdx).trim();
            const expr = item.slice(eqIdx + 1).trim();
            if (!/^[A-Za-z_]\w*$/.test(name)) {
                throw new Error(`Invalid enum member name "${name}" in ${typeName}`);
            }
            const val = evalCExpr(expr, symbols);
            symbols.set(name, val);
            allMembers.set(name, val);
            groupMap.set(name, val);
        }
        groups.set(typeName, groupMap);
    }

    return { allMembers, groups };
}

function parseEnums(src, initialSymbols = new Map()) {
    return parseEnumsDetailed(src, initialSymbols).allMembers;
}

function parseStructs(src, symbols) {
    const lexed = blankPreprocessor(lexC(src));
    const structs = new Map();
    const structRe = /typedef\s+struct\s*(?:[A-Za-z_]\w*)?\s*\{([^}]*)\}\s*([A-Za-z_]\w*)\s*;/g;

    let m;
    while ((m = structRe.exec(lexed)) !== null) {
        const body = m[1];
        const typeName = m[2];
        const fields = [];
        const decls = body.split(';').map((s) => s.trim()).filter(Boolean);

        for (const decl of decls) {
            if (decl.includes(',')) {
                throw new Error(`Multiple declarators in struct ${typeName}: "${decl}"`);
            }
            let arrayLen = null;
            let mainPart = decl;
            const arrMatch = decl.match(/^(.*?)\[([^\]]+)\]\s*$/);
            if (arrMatch) {
                mainPart = arrMatch[1].trim();
                arrayLen = evalCExpr(arrMatch[2].trim(), symbols);
            }
            const nameMatch = mainPart.match(/^(.+?)\b([A-Za-z_]\w*)$/);
            if (!nameMatch) {
                throw new Error(`Cannot parse struct field "${decl}" in ${typeName}`);
            }
            const type = nameMatch[1].trim();
            const name = nameMatch[2].trim();
            fields.push({ type, name, arrayLen });
        }

        structs.set(typeName, fields);
    }

    return structs;
}

function parseParams(paramStr) {
    const trimmed = paramStr.trim();
    if (!trimmed || trimmed === 'void') {
        return [];
    }
    return trimmed.split(',').map((raw) => {
        const p = raw.trim();
        const isPointer = p.includes('*');
        const nameMatch = p.match(/([A-Za-z_]\w*)\s*$/);
        const name = nameMatch ? nameMatch[1] : '';
        const type = p.slice(0, p.length - name.length).trim();
        return { type, name, isPointer };
    });
}

function findFunctionDefs(src) {
    const lexed = lexC(src);
    const cleaned = blankPreprocessor(lexed);
    const defs = [];
    const keywords = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'else', 'do']);

    let depth = 0;
    let stmtStart = 0;
    let i = 0;

    while (i < cleaned.length) {
        const ch = cleaned[i];
        if (ch === '{') {
            if (depth === 0) {
                const header = cleaned.slice(stmtStart, i);
                const m = header.match(/([A-Za-z_][\w\s\*]*?)\b([A-Za-z_]\w*)\s*\(([^()]*)\)\s*$/);
                if (m && !keywords.has(m[2]) && !/\btypedef\b/.test(header)) {
                    const name = m[2];
                    const params = parseParams(m[3]);
                    const bodyStart = i + 1;
                    let j = i + 1;
                    let bDepth = 1;
                    while (j < cleaned.length && bDepth > 0) {
                        if (cleaned[j] === '{') bDepth++;
                        else if (cleaned[j] === '}') bDepth--;
                        j++;
                    }
                    const bodyEnd = j - 1;
                    defs.push({
                        name,
                        params,
                        body: lexed.slice(bodyStart, bodyEnd),
                        start: stmtStart,
                        end: j
                    });
                    i = j;
                    stmtStart = j;
                    continue;
                }
            }
            depth++;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            if (depth === 0) stmtStart = i + 1;
        } else if (ch === ';' && depth === 0) {
            stmtStart = i + 1;
        }
        i++;
    }

    return defs;
}

function getHostSimSpan(src) {
    const lexed = lexC(src);
    const lines = lexed.split('\n');
    let offset = 0;
    let ifDepth = 0;
    let hostIfDepth = -1;
    let spanStart = -1;
    let spanEnd = -1;

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^#\s*if\b|^#\s*ifdef\b|^#\s*ifndef\b/.test(trimmed)) {
            ifDepth++;
            if (hostIfDepth === -1 && /^#\s*if\s+defined\s*\(\s*BMS_HOST_SIM\s*\)/.test(trimmed)) {
                hostIfDepth = ifDepth;
                spanStart = offset;
            }
        } else if (/^#\s*endif\b/.test(trimmed)) {
            if (ifDepth === hostIfDepth) {
                spanEnd = offset + line.length;
                hostIfDepth = -1;
            }
            if (ifDepth > 0) ifDepth--;
        }
        offset += line.length + 1;
    }

    return { spanStart, spanEnd };
}

function findPrototypes(src) {
    const lexed = lexC(src);
    const cleaned = blankPreprocessor(lexed);
    const { spanStart, spanEnd } = getHostSimSpan(src);
    const core = [];
    const mock = [];

    let depth = 0;
    let stmtStart = 0;

    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            if (depth === 0) stmtStart = i + 1;
        } else if (ch === ';' && depth === 0) {
            const stmt = cleaned.slice(stmtStart, i).trim();
            if (stmt && !/^typedef\b/.test(stmt)) {
                const m = stmt.match(/([A-Za-z_][\w\s\*]*?)\b([A-Za-z_]\w*)\s*\(([^()]*)\)\s*$/);
                if (m) {
                    const entry = {
                        name: m[2],
                        paramCount: parseParams(m[3]).length
                    };
                    if (spanStart !== -1 && stmtStart >= spanStart && i <= spanEnd) {
                        mock.push(entry);
                    } else {
                        core.push(entry);
                    }
                }
            }
            stmtStart = i + 1;
        }
    }

    return { core, mock };
}

describe('C Firmware Static & Dual-Track Parity Checks (CF-01..CF-25)', () => {
    const allCFiles = collectFiles('firmware', (rel) => /\.[ch]$/.test(rel));
    const allHeaderFiles = collectFiles('firmware/include', (rel) => /\.h$/.test(rel));
    const allSimFiles = collectFiles('sim', (rel) => /\.mjs$/.test(rel));

    test('CF-01: All Phase 1..5 firmware and sim files exist and are non-empty', () => {
        const required = [
            'firmware/Makefile',
            'firmware/CMakeLists.txt',
            'firmware/include/bms_config.h',
            'firmware/include/bms_types.h',
            'firmware/include/hal_interface.h',
            'firmware/include/ina226.h',
            'firmware/include/voltage_sensor.h',
            'firmware/include/bms_estimator.h',
            'firmware/include/bms_state_machine.h',
            'firmware/include/relay_ctrl.h',
            'firmware/include/bms_protection.h',
            'firmware/include/ssd1309_oled.h',
            'firmware/include/bms_app.h',
            'firmware/src/main.c',
            'firmware/src/hal/hal_stm32g4.c',
            'firmware/src/hal/hal_mock.c',
            'firmware/src/drivers/ina226.c',
            'firmware/src/drivers/voltage_sensor.c',
            'firmware/src/core/bms_estimator.c',
            'firmware/src/core/bms_state_machine.c',
            'firmware/src/drivers/relay_ctrl.c',
            'firmware/src/core/bms_protection.c',
            'firmware/src/drivers/ssd1309_oled.c',
            'firmware/src/app/bms_app.c',
            'sim/bms_config.mjs',
            'sim/bms_types.mjs',
            'sim/hal_mock.mjs',
            'sim/drivers/ina226.mjs',
            'sim/drivers/voltage_sensor.mjs',
            'sim/core/bms_estimator.mjs',
            'sim/core/bms_state_machine.mjs',
            'sim/drivers/relay_ctrl.mjs',
            'sim/core/bms_protection.mjs',
            'sim/drivers/ssd1309_oled.mjs',
            'sim/app/bms_app.mjs',
            'sim/run_sim.mjs'
        ];
        for (const rel of required) {
            assert.equal(existsSync(join(ROOT, rel)), true, `Missing required file: ${rel}`);
            const text = readNormalized(rel);
            assert.ok(text.trim().length > 0, `File is empty: ${rel}`);
        }
    });

    test('CF-02: All headers have proper #ifndef/#define/#endif include guards and no #pragma once', () => {
        const expectedGuards = new Map([
            ['firmware/include/bms_config.h', 'BMS_CONFIG_H'],
            ['firmware/include/bms_types.h', 'BMS_TYPES_H'],
            ['firmware/include/hal_interface.h', 'HAL_INTERFACE_H'],
            ['firmware/include/ina226.h', 'INA226_H'],
            ['firmware/include/voltage_sensor.h', 'VOLTAGE_SENSOR_H'],
            ['firmware/include/bms_estimator.h', 'BMS_ESTIMATOR_H'],
            ['firmware/include/bms_state_machine.h', 'BMS_STATE_MACHINE_H'],
            ['firmware/include/relay_ctrl.h', 'RELAY_CTRL_H'],
            ['firmware/include/bms_protection.h', 'BMS_PROTECTION_H'],
            ['firmware/include/ssd1309_oled.h', 'SSD1309_OLED_H'],
            ['firmware/include/bms_app.h', 'BMS_APP_H']
        ]);

        assert.ok(allHeaderFiles.length >= 3);
        for (const rel of allHeaderFiles) {
            const src = readNormalized(rel);
            assert.equal(/#\s*pragma\s+once\b/.test(src), false, `Forbidden #pragma once in ${rel}`);

            const directives = lexC(src)
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.startsWith('#'));

            assert.ok(directives.length >= 3, `Too few preprocessor directives in ${rel}`);
            const mIfndef = directives[0].match(/^#\s*ifndef\s+([A-Za-z_]\w*)$/);
            assert.ok(mIfndef, `First directive in ${rel} must be #ifndef GUARD, got: ${directives[0]}`);
            const guard = mIfndef[1];

            const mDefine = directives[1].match(/^#\s*define\s+([A-Za-z_]\w*)$/);
            assert.ok(mDefine && mDefine[1] === guard, `Second directive in ${rel} must be #define ${guard}`);

            assert.match(directives[directives.length - 1], /^#\s*endif\b/, `Last directive in ${rel} must be #endif`);

            if (expectedGuards.has(rel)) {
                assert.equal(guard, expectedGuards.get(rel), `Unexpected guard name in ${rel}`);
            }
        }
    });

    test('CF-03: Balanced braces, parentheses, and brackets across all firmware C/H files', () => {
        const pairs = new Map([['{', '}'], ['(', ')'], ['[', ']']]);
        const closers = new Set(['}', ')', ']']);

        for (const rel of allCFiles) {
            const lexed = lexC(readNormalized(rel));
            const stack = [];
            let line = 1;

            for (let i = 0; i < lexed.length; i++) {
                const ch = lexed[i];
                if (ch === '\n') {
                    line++;
                    continue;
                }
                if (pairs.has(ch)) {
                    stack.push({ expected: pairs.get(ch), open: ch, line });
                } else if (closers.has(ch)) {
                    assert.ok(stack.length > 0, `Unmatched '${ch}' in ${rel}:${line}`);
                    const top = stack.pop();
                    assert.equal(ch, top.expected, `Mismatched '${ch}' in ${rel}:${line} (opened '${top.open}' at line ${top.line})`);
                }
            }
            assert.equal(stack.length, 0, `Unclosed delimiter(s) in ${rel}: ${JSON.stringify(stack)}`);
        }
    });

    test('CF-04: No forbidden TODO/FIXME/XXX/TBD/stub keywords in firmware, build files, or sim', () => {
        const targets = [...allCFiles, 'firmware/Makefile', 'firmware/CMakeLists.txt', ...allSimFiles];
        for (const rel of targets) {
            const text = readNormalized(rel);
            assert.equal(/\b(TODO|FIXME|XXX|TBD)\b/.test(text), false, `Forbidden marker in ${rel}`);
            assert.equal(/\bstub\b/i.test(text), false, `Forbidden word "stub" in ${rel}`);
        }
    });

    test('CF-05: No empty function bodies in firmware C/H files', () => {
        for (const rel of allCFiles) {
            const defs = findFunctionDefs(readNormalized(rel));
            for (const fn of defs) {
                const stripped = fn.body
                    .replace(/\(\s*void\s*\)\s*[A-Za-z_]\w*\s*;/g, '')
                    .replace(/\breturn\s*;/g, '')
                    .replace(/\s+/g, '');
                assert.ok(stripped.length > 0, `Empty function body for ${fn.name} in ${rel}`);
            }
        }
    });

    test('CF-06: ASCII only, no heap allocation, no printf in hal_stm32g4.c, and proper stdbool/stdint includes', () => {
        const headerTexts = new Map();
        for (const rel of allHeaderFiles) {
            headerTexts.set(rel, readNormalized(rel));
        }

        function headerProvides(rel, stdHeader, visited = new Set()) {
            if (visited.has(rel)) return false;
            visited.add(rel);
            const txt = headerTexts.get(rel);
            if (!txt) return false;
            if (txt.includes(`<${stdHeader}>`)) return true;
            const incRe = /#\s*include\s*"([^"]+)"/g;
            let m;
            while ((m = incRe.exec(txt)) !== null) {
                const target = `firmware/include/${m[1]}`;
                if (headerProvides(target, stdHeader, visited)) return true;
            }
            return false;
        }

        for (const rel of allCFiles) {
            const src = readNormalized(rel);
            for (let i = 0; i < src.length; i++) {
                assert.ok(src.charCodeAt(i) <= 0x7F, `Non-ASCII byte at index ${i} in ${rel}`);
            }
            const lexed = lexC(src);
            assert.equal(/\b(malloc|calloc|realloc|free)\s*\(/.test(lexed), false, `Heap allocation forbidden in ${rel}`);
            if (rel === 'firmware/src/hal/hal_stm32g4.c') {
                assert.equal(/\bprintf\b/.test(src), false, 'printf forbidden in hal_stm32g4.c');
            }
        }

        for (const rel of allHeaderFiles) {
            const lexed = lexC(headerTexts.get(rel));
            if (/\bbool\b/.test(lexed)) {
                assert.equal(headerProvides(rel, 'stdbool.h'), true, `${rel} uses bool without <stdbool.h>`);
            }
            if (/\bu?int(?:8|16|32|64)_t\b/.test(lexed)) {
                assert.equal(headerProvides(rel, 'stdint.h'), true, `${rel} uses fixed-width int without <stdint.h>`);
            }
        }
    });

    test('CF-07: Literal suffixes and macro hygiene in bms_config.h', () => {
        const src = readNormalized('firmware/include/bms_config.h');
        const lexed = lexC(src);
        const lines = lexed.split('\n');

        for (const line of lines) {
            if (!/^\s*#\s*define\b/.test(line)) continue;
            assert.equal(/^\s*#\s*define\s+[A-Za-z_]\w*\(/.test(line), false, `Function-like macro forbidden: ${line}`);
            const m = line.match(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+(.+)$/);
            if (!m) continue;
            const name = m[1];
            const val = m[2].trim();

            assert.equal(/[\*\/+]/.test(val), false, `Operators *, /, + forbidden in ${name}: ${val}`);

            const numRe = /\b(0[xX][0-9a-fA-F]+|\d+\.\d*|\.\d+|\d+)([uUlLfF]*)\b/g;
            let nm;
            while ((nm = numRe.exec(val)) !== null) {
                const lit = nm[1];
                const suf = nm[2];
                if (lit.includes('.')) {
                    assert.match(suf, /^[fF]$/, `Float literal ${lit} in ${name} must have f/F suffix`);
                } else if (name !== 'INA226_CURRENT_SIGN') {
                    assert.match(suf, /^[uU]$/, `Integer literal ${lit} in ${name} must have U/u suffix`);
                }
            }
        }
    });

    test('CF-08: Bidirectional parity between bms_config.h and sim/bms_config.mjs', () => {
        const cDefines = parseDefines(readNormalized('firmware/include/bms_config.h'));
        const jsNumeric = new Map(
            Object.entries(cfg).filter(([k, v]) => typeof v === 'number' && /^[A-Z][A-Z0-9_]*$/.test(k))
        );

        const missingInJs = [...cDefines.keys()].filter((k) => !jsNumeric.has(k));
        const extraInJs = [...jsNumeric.keys()].filter((k) => !cDefines.has(k));
        assert.deepEqual(missingInJs, [], `Missing in sim/bms_config.mjs: ${missingInJs.join(', ')}`);
        assert.deepEqual(extraInJs, [], `Extra in sim/bms_config.mjs: ${extraInJs.join(', ')}`);

        for (const [k, cVal] of cDefines) {
            const jsVal = jsNumeric.get(k);
            assert.ok(Object.is(cVal, jsVal), `Mismatch on ${k}: C=${cVal}, JS=${jsVal}`);
        }

        assert.equal(cfg.INA226_SHUNT_OHM, 0.002);
        assert.equal(cfg.VSENSE_DIVIDER_RATIO, 5.987);
        assert.equal(cfg.PROT_BAT_OV_TRIP_V, 16.85);
        assert.equal(cfg.PROT_BAT_OV_CRIT_V, 16.9);
        assert.equal(cfg.PROT_SHORT_CIRCUIT_A, 18.0);
        assert.equal(cfg.BMS_CHARGE_EFFICIENCY, 0.992);
        assert.equal(cfg.OCV_REST_QUALIFY_MS, 1800000);
        assert.equal(cfg.RELAY4_AUX_PIN, 3);
        assert.equal(cfg.OLED_SCK_PORT, cfg.BMS_PORT_A);
        assert.equal(cfg.BMS_PORT_A, 0);

        assert.equal(Object.isFrozen(cfg.BMS_CONFIG), true);
        assert.deepEqual(Object.keys(cfg.BMS_CONFIG).sort(), [...cDefines.keys()].sort());
        for (const [k, cVal] of cDefines) {
            assert.ok(Object.is(cfg.BMS_CONFIG[k], cVal), `BMS_CONFIG.${k} mismatch`);
        }
    });

    test('CF-09: Bidirectional parity between bms_types.h and sim/bms_types.mjs', () => {
        const configDefines = parseDefines(readNormalized('firmware/include/bms_config.h'));
        const typesSrc = readNormalized('firmware/include/bms_types.h');
        const typesDefines = parseDefines(typesSrc);
        const { allMembers: enumMembers, groups: enumGroups } = parseEnumsDetailed(typesSrc, configDefines);

        const cSymbols = new Map([...typesDefines, ...enumMembers]);
        const jsNumeric = new Map(
            Object.entries(types).filter(([k, v]) => typeof v === 'number' && /^[A-Z][A-Z0-9_]*$/.test(k))
        );

        const missingInJs = [...cSymbols.keys()].filter((k) => !jsNumeric.has(k));
        const extraInJs = [...jsNumeric.keys()].filter((k) => !cSymbols.has(k));
        assert.deepEqual(missingInJs, [], `Missing in sim/bms_types.mjs: ${missingInJs.join(', ')}`);
        assert.deepEqual(extraInJs, [], `Extra in sim/bms_types.mjs: ${extraInJs.join(', ')}`);

        for (const [k, cVal] of cSymbols) {
            assert.ok(Object.is(cVal, jsNumeric.get(k)), `Mismatch on ${k}: C=${cVal}, JS=${jsNumeric.get(k)}`);
        }

        assert.equal(cSymbols.get('FAULT_RELAY_NO_RESPONSE'), 256);
        assert.equal(types.FAULT_RELAY_NO_RESPONSE, 256);
        assert.equal(types.FAULT_ALL_MASK, 0x1FF);

        const faultBits = [...jsNumeric.entries()].filter(
            ([k]) => k.startsWith('FAULT_') && k !== 'FAULT_NONE' && k !== 'FAULT_ALL_MASK' && k !== 'FAULT_COUNT'
        );
        assert.equal(faultBits.length, 9);
        const seenBits = new Set();
        let orBig = 0n;
        for (const [k, v] of faultBits) {
            assert.equal((v >>> 0), v, `${k} must fit unsigned 32-bit`);
            assert.ok(v > 0 && (v & (v - 1)) === 0, `${k}=${v} must be a power of 2`);
            assert.equal(seenBits.has(v), false, `Duplicate fault bit ${v} for ${k}`);
            seenBits.add(v);
            orBig |= BigInt(v);
        }
        assert.equal(Number(orBig), types.FAULT_ALL_MASK);

        const groupMapping = [
            ['bms_mode_t', 'BMS_MODE'],
            ['bms_prot_level_t', 'PROT_LEVEL'],
            ['bms_fault_code_t', 'FAULT'],
            ['bms_relay_id_t', 'RELAY_ID'],
            ['bms_oled_page_t', 'OLED_PAGE']
        ];
        for (const [cEnumName, jsGroupName] of groupMapping) {
            const jsObj = types[jsGroupName];
            const cMap = enumGroups.get(cEnumName);
            assert.ok(cMap, `Missing C enum ${cEnumName}`);
            assert.equal(Object.isFrozen(jsObj), true, `${jsGroupName} must be frozen`);
            assert.deepEqual(Object.keys(jsObj), [...cMap.keys()]);
            for (const [k, v] of cMap) {
                assert.equal(jsObj[k], v, `${jsGroupName}.${k} mismatch`);
            }
        }
    });

    test('CF-10: Struct field parity and exact key ordering between C and JS', () => {
        const cfgDefines = parseDefines(readNormalized('firmware/include/bms_config.h'));
        const typesSrc = readNormalized('firmware/include/bms_types.h');
        const halSrc = readNormalized('firmware/include/hal_interface.h');

        const typesSymbols = new Map([
            ...cfgDefines,
            ...parseDefines(typesSrc),
            ...parseEnums(typesSrc, cfgDefines)
        ]);
        const halSymbols = new Map([
            ...typesSymbols,
            ...parseDefines(halSrc)
        ]);

        const structs = new Map([
            ...parseStructs(typesSrc, typesSymbols),
            ...parseStructs(halSrc, halSymbols)
        ]);

        function verifyStruct(cStructName, jsObj) {
            const cFields = structs.get(cStructName);
            assert.ok(cFields, `Missing C struct ${cStructName}`);
            assert.equal(typeof jsObj, 'object');
            assert.notEqual(jsObj, null);
            assert.deepEqual(Object.keys(jsObj), cFields.map((f) => f.name), `Field order mismatch in ${cStructName}`);

            for (const f of cFields) {
                const val = jsObj[f.name];
                if (f.arrayLen !== null) {
                    const isTypedOrArr = Array.isArray(val) || val instanceof Uint8Array;
                    assert.equal(isTypedOrArr, true, `${cStructName}.${f.name} must be Array or Uint8Array`);
                    if (cStructName === 'hal_mock_oled_state_t' && f.name === 'cmd_log') {
                        assert.equal(val.length, jsObj.cmd_log_len);
                    } else {
                        assert.equal(val.length, f.arrayLen, `${cStructName}.${f.name} length mismatch`);
                    }
                    if (cStructName === 'hal_mock_oled_state_t' && f.type === 'uint8_t' && f.name === 'last_data') {
                        assert.equal(val instanceof Uint8Array, true);
                    }
                } else if (f.type === 'bool') {
                    assert.equal(typeof val, 'boolean', `${cStructName}.${f.name} must be boolean`);
                } else if (structs.has(f.type)) {
                    verifyStruct(f.type, val);
                } else {
                    assert.equal(typeof val, 'number', `${cStructName}.${f.name} (${f.type}) must be number`);
                }
            }
        }

        const state = types.createDefaultSystemState();
        verifyStruct('bms_system_state_t', state);
        verifyStruct('bms_measurements_t', state.meas);
        verifyStruct('bms_energy_state_t', state.energy);
        verifyStruct('bms_relay_state_t', state.relays);
        verifyStruct('bms_fault_snapshot_t', state.snapshot);

        halMock.hal_mock_reset();
        verifyStruct('hal_mock_oled_state_t', halMock.hal_mock_get_oled_state());
    });

    test('CF-11: HAL API parity across hal_interface.h, hal_stm32g4.c, hal_mock.c, and sim/*.mjs', () => {
        const halHdrSrc = readNormalized('firmware/include/hal_interface.h');
        const { core, mock } = findPrototypes(halHdrSrc);

        const expectedCore = [
            'hal_init', 'hal_relay_open_all', 'hal_i2c3_is_device_ready',
            'hal_i2c3_write_reg16', 'hal_i2c3_read_reg16', 'hal_adc_pa0_read_raw',
            'hal_adc_pa0_read_pin_voltage', 'hal_relay_write', 'hal_relay_read_cmd',
            'hal_relay_read_feedback', 'hal_oled_reset', 'hal_oled_write_cmd',
            'hal_oled_write_data', 'hal_get_tick_ms', 'hal_delay_ms'
        ];
        const expectedMock = [
            'hal_mock_reset', 'hal_mock_set_i2c_online', 'hal_mock_set_ina226_register',
            'hal_mock_get_ina226_register', 'hal_mock_set_adc_pa0_raw',
            'hal_mock_set_adc_pa0_pin_voltage', 'hal_mock_set_adc_fault',
            'hal_mock_set_spi_fault', 'hal_mock_set_relay_feedback_override',
            'hal_mock_set_tick_ms', 'hal_mock_advance_tick_ms', 'hal_mock_is_initialized',
            'hal_mock_get_oled_state', 'hal_mock_get_relay_log_count',
            'hal_mock_get_relay_event', 'hal_mock_clear_relay_log'
        ];

        assert.deepEqual(core.map((p) => p.name), expectedCore);
        assert.deepEqual(mock.map((p) => p.name), expectedMock);

        const allProtoMap = new Map([...core, ...mock].map((p) => [p.name, p.paramCount]));
        const jsFns = Object.entries(halMock).filter(([, v]) => typeof v === 'function');
        assert.deepEqual(
            jsFns.map(([k]) => k).sort(),
            [...allProtoMap.keys()].sort(),
            'sim/hal_mock.mjs exported functions must match 31 HAL prototypes'
        );

        for (const [name, fn] of jsFns) {
            assert.equal(fn.length, allProtoMap.get(name), `Param count mismatch for ${name}`);
        }

        const stm32Defs = new Set(findFunctionDefs(readNormalized('firmware/src/hal/hal_stm32g4.c')).map((d) => d.name));
        const mockDefs = new Set(findFunctionDefs(readNormalized('firmware/src/hal/hal_mock.c')).map((d) => d.name));

        for (const name of expectedCore) {
            assert.equal(stm32Defs.has(name), true, `hal_stm32g4.c missing core fn ${name}`);
            assert.equal(mockDefs.has(name), true, `hal_mock.c missing core fn ${name}`);
        }
        for (const name of expectedMock) {
            assert.equal(mockDefs.has(name), true, `hal_mock.c missing mock fn ${name}`);
            assert.equal(stm32Defs.has(name), false, `hal_stm32g4.c must not define mock fn ${name}`);
        }

        const halDefines = parseDefines(halHdrSrc);
        assert.equal(halMock.HAL_MOCK_OLED_CMD_LOG_SIZE, halDefines.get('HAL_MOCK_OLED_CMD_LOG_SIZE'));
        assert.equal(halMock.HAL_MOCK_RELAY_LOG_SIZE, halDefines.get('HAL_MOCK_RELAY_LOG_SIZE'));

        assert.equal(typeof types.createDefaultSystemState, 'function');
        assert.equal(typeof types.bms_system_state_init, 'function');
        assert.equal(types.bms_system_state_init.length, 1);
    });

    test('CF-12: NULL pointer guards in all pointer-accepting C functions', () => {
        const files = [
            'firmware/src/hal/hal_mock.c',
            'firmware/src/hal/hal_stm32g4.c',
            'firmware/src/main.c',
            'firmware/include/bms_types.h',
            'firmware/src/drivers/ina226.c',
            'firmware/src/drivers/voltage_sensor.c',
            'firmware/src/core/bms_estimator.c',
            'firmware/src/core/bms_state_machine.c',
            'firmware/src/drivers/relay_ctrl.c',
            'firmware/src/core/bms_protection.c',
            'firmware/src/drivers/ssd1309_oled.c',
            'firmware/src/app/bms_app.c'
        ];
        const checkedPointerParams = new Set();

        for (const rel of files) {
            const defs = findFunctionDefs(readNormalized(rel));
            for (const fn of defs) {
                for (const p of fn.params) {
                    if (!p.isPointer) continue;
                    checkedPointerParams.add(p.name);
                    const re = new RegExp(`\\b${p.name}\\s*==\\s*NULL\\b|\\bNULL\\s*==\\s*${p.name}\\b`);
                    assert.match(fn.body, re, `${rel}:${fn.name} missing NULL check for ${p.name}`);
                }
            }
        }

        for (const req of ['out_value', 'out_raw', 'out_pin_v', 'data', 'out_event', 'state', 'meas']) {
            assert.equal(checkedPointerParams.has(req), true, `Expected pointer param ${req} to be covered`);
        }
    });

    test('CF-13: Relay ID bounds checking in both HAL C implementations', () => {
        const halFiles = ['firmware/src/hal/hal_mock.c', 'firmware/src/hal/hal_stm32g4.c'];
        const boundsRe = /\(\s*uint32_t\s*\)\s*relay_id\s*>=\s*\(\s*uint32_t\s*\)\s*RELAY_COUNT/;

        for (const rel of halFiles) {
            const defs = findFunctionDefs(readNormalized(rel));
            for (const fn of defs) {
                const hasRelayId = fn.params.some((p) => p.type.includes('bms_relay_id_t') && p.name === 'relay_id');
                if (hasRelayId) {
                    assert.match(fn.body, boundsRe, `${rel}:${fn.name} missing relay_id bounds check`);
                }
            }
        }
    });

    test('CF-14: OLED write_data length check and ADC raw clamp in both HAL C implementations', () => {
        const halFiles = ['firmware/src/hal/hal_mock.c', 'firmware/src/hal/hal_stm32g4.c'];

        for (const rel of halFiles) {
            const defs = findFunctionDefs(readNormalized(rel));
            const oledData = defs.find((d) => d.name === 'hal_oled_write_data');
            assert.ok(oledData, `${rel} missing hal_oled_write_data`);
            assert.match(oledData.body, /\blen\s*==\s*0[uU]?\b/);
            assert.match(oledData.body, /\blen\s*>\s*OLED_BUFFER_SIZE\b/);

            const adcRead = defs.find((d) => d.name === 'hal_adc_pa0_read_raw');
            assert.ok(adcRead, `${rel} missing hal_adc_pa0_read_raw`);
            assert.match(adcRead.body, /\bADC_RESOLUTION\b/);
        }
    });

    test('CF-15: Target guard, STM32G473 configuration, SWD protection, and safe relay open sequence', () => {
        const stmSrc = readNormalized('firmware/src/hal/hal_stm32g4.c');
        const mockSrc = readNormalized('firmware/src/hal/hal_mock.c');

        const idxGuard = stmSrc.search(/#\s*if\s+defined\s*\(\s*USE_HAL_DRIVER\s*\)|#\s*ifdef\s+USE_HAL_DRIVER\b/);
        const idxHalInc = stmSrc.indexOf('#include "stm32g4xx_hal.h"');
        const idxElse = stmSrc.search(/\n#\s*else\b/);
        assert.ok(idxGuard !== -1 && idxHalInc > idxGuard, 'stm32g4xx_hal.h must be inside USE_HAL_DRIVER guard');
        assert.ok(idxElse > idxHalInc, 'Missing #else fallback branch in hal_stm32g4.c');
        assert.match(stmSrc, /#\s*if\s*!defined\s*\(\s*STM32G473xx\s*\)[\s\S]*?#\s*error\b/);
        assert.match(stmSrc.slice(idxElse), /\btypedef\b/);

        const stmDefs = findFunctionDefs(stmSrc);
        for (const fn of stmDefs) {
            assert.ok(fn.start > idxGuard && fn.end < idxElse, `Function ${fn.name} must reside inside USE_HAL_DRIVER branch`);
        }

        const requiredTokens = [
            'GPIOA', 'GPIOB', 'GPIOC', 'GPIO_PIN_0', 'GPIO_PIN_1', 'GPIO_PIN_2', 'GPIO_PIN_3',
            'GPIO_PIN_5', 'GPIO_PIN_6', 'GPIO_PIN_7', 'GPIO_PIN_8', 'GPIO_PIN_9',
            'GPIO_AF5_SPI1', 'GPIO_AF8_I2C3', 'GPIO_MODE_ANALOG', 'GPIO_MODE_AF_OD',
            'SPI1', 'I2C3', 'ADC1', 'ADC_CHANNEL_1', 'HAL_ADCEx_Calibration_Start', 'HAL_ADC_Stop',
            'RCC_PLLM_DIV4', 'FLASH_LATENCY_4', 'SysTick_Handler', 'HAL_IncTick',
            'BMS_HAL_NO_SYSTICK_HANDLER', 'RELAY_ACTIVE_HIGH', '<< 1'
        ];
        for (const tok of requiredTokens) {
            assert.ok(stmSrc.includes(tok), `hal_stm32g4.c missing token: ${tok}`);
        }

        for (const forbidden of ['GPIO_PIN_13', 'GPIO_PIN_14', 'HAL_Delay(']) {
            assert.equal(stmSrc.includes(forbidden), false, `hal_stm32g4.c must not contain ${forbidden}`);
        }

        const stmInit = stmDefs.find((d) => d.name === 'hal_init');
        assert.ok(stmInit);
        const idxGpiocClk = stmInit.body.indexOf('__HAL_RCC_GPIOC_CLK_ENABLE');
        const idxFirstOpen = stmInit.body.indexOf('hal_relay_open_all(');
        const idxSecondOpen = stmInit.body.indexOf('hal_relay_open_all(', idxFirstOpen + 1);
        const idxFirstGpioInit = stmInit.body.indexOf('HAL_GPIO_Init(');
        assert.ok(idxGpiocClk !== -1 && idxFirstOpen !== -1 && idxFirstGpioInit !== -1);
        assert.ok(idxGpiocClk < idxFirstOpen, 'GPIOC clock must enable before hal_relay_open_all()');
        assert.ok(idxFirstOpen < idxFirstGpioInit, 'hal_relay_open_all() must drive ODR before HAL_GPIO_Init()');
        assert.ok(idxSecondOpen !== -1, 'hal_relay_open_all() must appear at least twice in hal_init');

        assert.match(mockSrc, /#\s*if\s+defined\s*\(\s*USE_HAL_DRIVER\s*\)[\s\S]*?#\s*error\b/);
        assert.match(mockSrc, /#\s*if\s*!defined\s*\(\s*BMS_HOST_SIM\s*\)[\s\S]*?#\s*error\b/);

        const mockDefs = findFunctionDefs(mockSrc);
        const mockInit = mockDefs.find((d) => d.name === 'hal_init');
        assert.ok(mockInit && mockInit.body.includes('hal_relay_open_all('));

        for (const [label, defs] of [['hal_stm32g4.c', stmDefs], ['hal_mock.c', mockDefs]]) {
            const openAll = defs.find((d) => d.name === 'hal_relay_open_all');
            assert.ok(openAll, `${label} missing hal_relay_open_all`);
            const i3 = openAll.body.indexOf('RELAY_3_LOAD');
            const i2 = openAll.body.indexOf('RELAY_2_CHARGE');
            const i4 = openAll.body.indexOf('RELAY_4_AUX');
            const i1 = openAll.body.indexOf('RELAY_1_MAIN');
            assert.ok(i3 !== -1 && i3 < i2 && i2 < i4 && i4 < i1, `${label} wrong open_all relay order`);
        }
    });

    test('CF-16: main.c startup safety, control loop period, and host simulation exit', () => {
        const mainSrc = readNormalized('firmware/src/main.c');
        const mainDefs = findFunctionDefs(mainSrc);
        const mainFn = mainDefs.find((d) => d.name === 'main');
        assert.ok(mainFn, 'main.c missing main function');
        assert.match(mainSrc, /\bint\s+main\s*\(\s*void\s*\)/);

        const idxHalInit = mainFn.body.indexOf('hal_init(');
        const idxStateInit = mainFn.body.indexOf('bms_system_state_init(');
        assert.ok(idxHalInit !== -1 && idxStateInit !== -1 && idxHalInit < idxStateInit);

        for (const tok of [
            'CONTROL_LOOP_PERIOD_MS', 'hal_relay_open_all', 'BMS_HOST_SIM',
            'BMS_HOST_SIM_RUN_MS', 'bms_app_init(', 'bms_app_step('
        ]) {
            assert.ok(mainSrc.includes(tok), `main.c missing ${tok}`);
        }
        assert.equal(/\bhal_mock_/.test(mainSrc), false, 'main.c must not call hal_mock_* functions');
    });

    test('CF-17: Makefile and CMakeLists.txt contain all required target and host flags', () => {
        const makefile = readNormalized('firmware/Makefile');
        const cmake = readNormalized('firmware/CMakeLists.txt');

        const makeTokens = [
            '-mcpu=cortex-m4', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard', '-mthumb',
            '-DSTM32G473xx', '-DUSE_HAL_DRIVER', '-DBMS_HOST_SIM', '-std=c99',
            'hal_mock.c', 'hal_stm32g4.c', 'arm-none-eabi-gcc', 'host_sim', 'stm32g473', 'CUBE_DIR'
        ];
        for (const tok of makeTokens) {
            assert.ok(makefile.includes(tok), `Makefile missing ${tok}`);
        }

        const cmakeTokens = [
            'cmake_minimum_required', 'project(', 'CMAKE_C_STANDARD 99', 'BMS_TARGET',
            'STM32G473xx', 'USE_HAL_DRIVER', 'BMS_HOST_SIM', 'cortex-m4', 'fpv4-sp-d16',
            'hal_mock.c', 'hal_stm32g4.c'
        ];
        for (const tok of cmakeTokens) {
            assert.ok(cmake.includes(tok), `CMakeLists.txt missing ${tok}`);
        }

        const idxSysName = cmake.indexOf('set(CMAKE_SYSTEM_NAME Generic)');
        const idxProject = cmake.indexOf('project(');
        assert.ok(idxSysName !== -1 && idxProject !== -1 && idxSysName < idxProject);

        const p2Srcs = [
            'src/drivers/ina226.c',
            'src/drivers/voltage_sensor.c',
            'src/core/bms_estimator.c',
            'src/core/bms_state_machine.c',
            'src/drivers/relay_ctrl.c',
            'src/core/bms_protection.c',
            'src/drivers/ssd1309_oled.c',
            'src/app/bms_app.c'
        ];
        for (const src of p2Srcs) {
            const mkCount = makefile.split(src).length - 1;
            const cmCount = cmake.split(src).length - 1;
            assert.ok(mkCount >= 2, `Makefile must include ${src} in both host and target (${mkCount})`);
            assert.ok(cmCount >= 2, `CMakeLists.txt must include ${src} in both host and target (${cmCount})`);
        }
    });

    test('CF-18: Phase 2/3 API parity across headers, C sources, and sim/*.mjs', () => {
        const modules = [
            {
                hdr: 'firmware/include/ina226.h',
                src: 'firmware/src/drivers/ina226.c',
                jsMod: ina226,
                expected: [
                    'ina226_reset',
                    'ina226_init',
                    'ina226_read',
                    'ina226_get_last_raw_current_a',
                    'ina226_encode_bus_voltage_reg',
                    'ina226_encode_shunt_current_reg'
                ]
            },
            {
                hdr: 'firmware/include/voltage_sensor.h',
                src: 'firmware/src/drivers/voltage_sensor.c',
                jsMod: vsense,
                expected: [
                    'voltage_sensor_reset',
                    'voltage_sensor_init',
                    'voltage_sensor_read',
                    'voltage_sensor_raw_to_charger_v'
                ]
            },
            {
                hdr: 'firmware/include/bms_estimator.h',
                src: 'firmware/src/core/bms_estimator.c',
                jsMod: estimator,
                expected: [
                    'bms_estimator_init',
                    'bms_estimator_calc_efficiency_pct',
                    'bms_estimator_ocv_to_soc_pct',
                    'bms_estimator_apply_rest_ocv_correction',
                    'bms_estimator_get_rest_time_ms',
                    'bms_estimator_step'
                ]
            }
        ];

        for (const m of modules) {
            const protos = findPrototypes(readNormalized(m.hdr)).core;
            assert.deepEqual(protos.map((p) => p.name), m.expected, `${m.hdr} prototype list mismatch`);

            const cDefs = new Map(findFunctionDefs(readNormalized(m.src)).map((d) => [d.name, d]));
            for (const p of protos) {
                const def = cDefs.get(p.name);
                assert.ok(def, `${m.src} missing definition for ${p.name}`);
                assert.equal(def.params.length, p.paramCount, `${m.src}:${p.name} param count mismatch`);
            }

            const jsFns = Object.entries(m.jsMod).filter(([, v]) => typeof v === 'function');
            assert.deepEqual(
                jsFns.map(([k]) => k).sort(),
                [...m.expected].sort(),
                `JS export mismatch for ${m.src}`
            );
            for (const p of protos) {
                assert.equal(m.jsMod[p.name].length, p.paramCount, `JS ${p.name}.length mismatch`);
            }
        }
    });

    test('CF-19: Phase 2 safety and math guards in C implementations', () => {
        const inaSrc = readNormalized('firmware/src/drivers/ina226.c');
        for (const tok of [
            'INA226_MANUFACTURER_ID_VALUE',
            'INA226_DIE_ID_VALUE',
            'INA226_CALIBRATION_VALUE',
            '(int16_t)',
            'PROT_SHORT_CIRCUIT_A',
            'PROT_DI_DT_MAX_A_PER_STEP',
            'INA226_BUS_VALID_MIN_V',
            'INA226_BUS_VALID_MAX_V',
            'INA226_BUS_REG_MAX'
        ]) {
            assert.ok(inaSrc.includes(tok), `ina226.c missing ${tok}`);
        }

        const vsSrc = readNormalized('firmware/src/drivers/voltage_sensor.c');
        for (const tok of [
            'ADC_PIN_MAX_SAFE_V',
            'VSENSE_DIVIDER_RATIO',
            'CHARGER_PRESENT_MIN_V',
            'ADC_RESOLUTION'
        ]) {
            assert.ok(vsSrc.includes(tok), `voltage_sensor.c missing ${tok}`);
        }

        const estSrc = readNormalized('firmware/src/core/bms_estimator.c');
        for (const tok of [
            'ina226_ok',
            'ESTIMATOR_MAX_DT_MS',
            'isfinite',
            'energy_in_wh <= 0.0f'
        ]) {
            assert.ok(estSrc.includes(tok), `bms_estimator.c missing ${tok}`);
        }
    });

    test('CF-20: Phase 3 bms_state_machine API parity across header, C source, and sim/core/bms_state_machine.mjs', () => {
        const expected = [
            'bms_state_machine_reset',
            'bms_state_machine_init',
            'bms_state_machine_is_charger_valid',
            'bms_state_machine_is_charge_complete',
            'bms_state_machine_step'
        ];
        const protos = findPrototypes(readNormalized('firmware/include/bms_state_machine.h')).core;
        assert.deepEqual(protos.map((p) => p.name), expected);

        const cDefs = new Map(findFunctionDefs(readNormalized('firmware/src/core/bms_state_machine.c')).map((d) => [d.name, d]));
        for (const p of protos) {
            const def = cDefs.get(p.name);
            assert.ok(def, `bms_state_machine.c missing definition for ${p.name}`);
            assert.equal(def.params.length, p.paramCount, `bms_state_machine.c:${p.name} param count mismatch`);
        }

        const jsFns = Object.entries(stateMachine).filter(([, v]) => typeof v === 'function');
        assert.deepEqual(jsFns.map(([k]) => k).sort(), [...expected].sort());
        for (const p of protos) {
            assert.equal(stateMachine[p.name].length, p.paramCount, `JS ${p.name}.length mismatch`);
        }
    });

    test('CF-21: Phase 3 safety and math guards in bms_estimator.c and bms_state_machine.c', () => {
        const estSrc = readNormalized('firmware/src/core/bms_estimator.c');
        for (const tok of [
            'BMS_CHARGE_EFFICIENCY',
            'BMS_NOMINAL_CAPACITY_AH',
            'OCV_REST_QUALIFY_MS',
            'OCV_CORRECTION_BLEND',
            'REST_CURRENT_THRESHOLD_A',
            'CHARGE_CV_COMPENSATION',
            'remaining_time_min',
            'estimated_charge_time_min'
        ]) {
            assert.ok(estSrc.includes(tok), `bms_estimator.c missing ${tok}`);
        }

        const smSrc = readNormalized('firmware/src/core/bms_state_machine.c');
        for (const tok of [
            'STARTUP_PRECHARGE_MS',
            'CHARGE_REENABLE_HYST_V',
            'CHARGE_CURRENT_MIN_A',
            'DISCHARGE_CURRENT_MIN_A',
            'CHARGE_DONE_VOLTAGE_V',
            'CHARGE_DONE_CURRENT_A',
            'hal_relay_open_all',
            'RELAY_4_AUX',
            'RELAY_1_MAIN',
            'RELAY_2_CHARGE',
            'RELAY_3_LOAD',
            'ESTIMATOR_MAX_DT_MS'
        ]) {
            assert.ok(smSrc.includes(tok), `bms_state_machine.c missing ${tok}`);
        }
    });

    test('CF-22: Phase 4 relay_ctrl and bms_protection API parity across headers, C sources, and sim/*.mjs', () => {
        const modules = [
            {
                hdr: 'firmware/include/relay_ctrl.h',
                src: 'firmware/src/drivers/relay_ctrl.c',
                jsMod: relayCtrl,
                expected: [
                    'relay_ctrl_init',
                    'relay_ctrl_sync',
                    'relay_ctrl_has_mismatch',
                    'relay_ctrl_set',
                    'relay_ctrl_isolate_all',
                    'relay_ctrl_apply_protection'
                ]
            },
            {
                hdr: 'firmware/include/bms_protection.h',
                src: 'firmware/src/core/bms_protection.c',
                jsMod: protection,
                expected: [
                    'bms_protection_reset',
                    'bms_protection_init',
                    'bms_protection_is_recovery_safe',
                    'bms_protection_request_fault_clear',
                    'bms_protection_step'
                ]
            }
        ];

        for (const m of modules) {
            const protos = findPrototypes(readNormalized(m.hdr)).core;
            assert.deepEqual(protos.map((p) => p.name), m.expected, `${m.hdr} prototype mismatch`);

            const cDefs = new Map(findFunctionDefs(readNormalized(m.src)).map((d) => [d.name, d]));
            for (const p of protos) {
                const def = cDefs.get(p.name);
                assert.ok(def, `${m.src} missing definition for ${p.name}`);
                assert.equal(def.params.length, p.paramCount, `${m.src}:${p.name} param count mismatch`);
            }

            const jsFns = Object.entries(m.jsMod).filter(([, v]) => typeof v === 'function');
            assert.deepEqual(jsFns.map(([k]) => k).sort(), [...m.expected].sort());
            for (const p of protos) {
                assert.equal(m.jsMod[p.name].length, p.paramCount, `JS ${p.name}.length mismatch`);
            }
        }
    });

    test('CF-23: Phase 4 safety and protection guards in relay_ctrl.c and bms_protection.c', () => {
        const rcSrc = readNormalized('firmware/src/drivers/relay_ctrl.c');
        for (const tok of [
            '(uint32_t)relay_id >= (uint32_t)RELAY_COUNT',
            'hal_relay_open_all',
            'fault_latched',
            'PROT_LEVEL_4_ISOLATE',
            'PROT_LEVEL_3_BRANCH',
            'FAULT_VSENSE_FAULT',
            'FAULT_RELAY_NO_RESPONSE',
            'fault_mismatch'
        ]) {
            assert.ok(rcSrc.includes(tok), `relay_ctrl.c missing ${tok}`);
        }

        const prSrc = readNormalized('firmware/src/core/bms_protection.c');
        for (const tok of [
            'FAULT_BAT_OVERVOLTAGE',
            'FAULT_BAT_UNDERVOLTAGE',
            'FAULT_CHG_OVERCURRENT',
            'FAULT_DIS_OVERCURRENT',
            'FAULT_SHORT_CIRCUIT',
            'FAULT_CHARGER_OVERVOLTAGE',
            'FAULT_INA226_DISCONNECTED',
            'FAULT_VSENSE_FAULT',
            'FAULT_RELAY_NO_RESPONSE',
            'PROT_LEVEL_1_NORMAL',
            'PROT_LEVEL_2_WARNING',
            'PROT_LEVEL_3_BRANCH',
            'PROT_LEVEL_4_ISOLATE',
            'PROT_LEVEL_5_LATCH',
            'PROT_DEBOUNCE_NORM_MS',
            'PROT_SHORT_CIRCUIT_A',
            'PROT_DI_DT_MAX_A_PER_STEP',
            'ADC_PIN_MAX_SAFE_V',
            'ESTIMATOR_MAX_DT_MS',
            'isfinite',
            'relay_ctrl_apply_protection'
        ]) {
            assert.ok(prSrc.includes(tok), `bms_protection.c missing ${tok}`);
        }
    });

    test('CF-24: Phase 5 OLED and bms_app API, constant & history struct parity', () => {
        const modules = [
            {
                hdr: 'firmware/include/ssd1309_oled.h',
                src: 'firmware/src/drivers/ssd1309_oled.c',
                jsMod: oledDrv,
                expected: [
                    'ssd1309_reset_state',
                    'ssd1309_init',
                    'ssd1309_clear_buffer',
                    'ssd1309_draw_text_line',
                    'ssd1309_render_page',
                    'ssd1309_flush',
                    'ssd1309_get_framebuffer',
                    'ssd1309_get_text_line',
                    'ssd1309_mode_label'
                ]
            },
            {
                hdr: 'firmware/include/bms_app.h',
                src: 'firmware/src/app/bms_app.c',
                jsMod: bmsApp,
                expected: [
                    'bms_app_reset',
                    'bms_app_init',
                    'bms_app_step',
                    'bms_app_next_page',
                    'bms_app_set_page',
                    'bms_app_request_fault_clear',
                    'bms_app_get_history_count',
                    'bms_app_get_history_entry'
                ]
            }
        ];

        for (const m of modules) {
            const protos = findPrototypes(readNormalized(m.hdr)).core;
            assert.deepEqual(protos.map((p) => p.name), m.expected, `${m.hdr} prototype mismatch`);

            const cDefs = new Map(findFunctionDefs(readNormalized(m.src)).map((d) => [d.name, d]));
            for (const p of protos) {
                const def = cDefs.get(p.name);
                assert.ok(def, `${m.src} missing definition for ${p.name}`);
                assert.equal(def.params.length, p.paramCount, `${m.src}:${p.name} param count mismatch`);
            }

            const jsFns = Object.entries(m.jsMod).filter(([, v]) => typeof v === 'function');
            assert.deepEqual(jsFns.map(([k]) => k).sort(), [...m.expected].sort());
            for (const p of protos) {
                assert.equal(m.jsMod[p.name].length, p.paramCount, `JS ${p.name}.length mismatch`);
            }
        }

        const oledDefines = parseDefines(readNormalized('firmware/include/ssd1309_oled.h'));
        assert.equal(oledDrv.SSD1309_TEXT_LINES, oledDefines.get('SSD1309_TEXT_LINES'));
        assert.equal(oledDrv.SSD1309_LINE_MAX_CHARS, oledDefines.get('SSD1309_LINE_MAX_CHARS'));

        const appHdrSrc = readNormalized('firmware/include/bms_app.h');
        const appDefines = parseDefines(appHdrSrc);
        assert.equal(bmsApp.BMS_HISTORY_CAPACITY, appDefines.get('BMS_HISTORY_CAPACITY'));

        const cfgDefines = parseDefines(readNormalized('firmware/include/bms_config.h'));
        const typesSrc = readNormalized('firmware/include/bms_types.h');
        const symbols = new Map([...cfgDefines, ...parseDefines(typesSrc), ...parseEnums(typesSrc, cfgDefines), ...appDefines]);
        const appStructs = parseStructs(appHdrSrc, symbols);
        const histFields = appStructs.get('bms_history_entry_t');
        assert.ok(histFields);

        halMock.hal_mock_reset();
        halMock.hal_init();
        const st = types.createDefaultSystemState();
        bmsApp.bms_app_init(st);
        const entryOut = {};
        assert.equal(bmsApp.bms_app_get_history_entry(0, entryOut), true);
        assert.deepEqual(Object.keys(entryOut), histFields.map((f) => f.name));
    });

    test('CF-25: Phase 5 OLED 4-page and 10 ms priority > 200 ms OLED guards in C', () => {
        const oledSrc = readNormalized('firmware/src/drivers/ssd1309_oled.c');
        for (const tok of [
            'OLED_PAGE_OVERVIEW',
            'OLED_PAGE_CHARGER',
            'OLED_PAGE_RELAYS',
            'OLED_PAGE_DIAGNOSTICS',
            'hal_oled_reset',
            'hal_oled_write_cmd',
            'hal_oled_write_data',
            'OLED_BUFFER_SIZE',
            'SSD1309_TEXT_LINES',
            'SSD1309_LINE_MAX_CHARS',
            'isfinite',
            'snprintf'
        ]) {
            assert.ok(oledSrc.includes(tok), `ssd1309_oled.c missing ${tok}`);
        }

        const appSrc = readNormalized('firmware/src/app/bms_app.c');
        for (const tok of [
            'ina226_read',
            'voltage_sensor_read',
            'bms_estimator_step',
            'bms_protection_step',
            'bms_state_machine_step',
            'relay_ctrl_apply_protection',
            'ssd1309_render_page',
            'ssd1309_flush',
            'OLED_REFRESH_PERIOD_MS',
            'OLED_AUTO_PAGE_MS',
            'OLED_PAGE_DIAGNOSTICS',
            'ESTIMATOR_MAX_DT_MS',
            'BMS_HISTORY_CAPACITY'
        ]) {
            assert.ok(appSrc.includes(tok), `bms_app.c missing ${tok}`);
        }

        const appDefs = findFunctionDefs(appSrc);
        const stepFn = appDefs.find((d) => d.name === 'bms_app_step');
        assert.ok(stepFn);
        const idxProt = stepFn.body.indexOf('bms_protection_step(');
        const idxRelay = stepFn.body.indexOf('relay_ctrl_apply_protection(');
        const idxFlush = stepFn.body.indexOf('ssd1309_flush(');
        assert.ok(idxProt !== -1 && idxRelay !== -1 && idxFlush !== -1);
        assert.ok(idxProt < idxFlush, 'bms_protection_step must run before ssd1309_flush');
        assert.ok(idxRelay < idxFlush, 'relay_ctrl_apply_protection must run before ssd1309_flush');
    });
});
