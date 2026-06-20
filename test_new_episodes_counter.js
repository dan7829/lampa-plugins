const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function createFakeDate(initial) {
    let now = Date.parse(initial || '2026-06-15T12:00:00Z');

    function FakeDate() {
        if (!(this instanceof FakeDate)) return new Date(now).toString();
        return arguments.length ? new Date(...arguments) : new Date(now);
    }

    Object.setPrototypeOf(FakeDate, Date);
    FakeDate.prototype = Date.prototype;
    FakeDate.now = () => now;
    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;
    FakeDate.setNow = (value) => {
        now = typeof value === 'number' ? value : Date.parse(value);
    };
    FakeDate.advance = (ms) => {
        now += ms;
    };

    return FakeDate;
}

function makeStorage(initial) {
    const data = Object.assign({}, initial || {});

    return {
        data,
        get(name, fallback) {
            return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : fallback;
        },
        set(name, value) {
            data[name] = value;
        }
    };
}

function classListOf(element) {
    return String(element.className || '').split(/\s+/).filter(Boolean);
}

function hasClass(element, className) {
    return classListOf(element).indexOf(className) !== -1;
}

function makeElement(className, tagName) {
    const element = {
        className: className || '',
        tagName: String(tagName || 'div').toUpperCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        textContent: '',
        id: '',
        events: {},
        appendChild(child) {
            child.parentNode = element;
            element.children.push(child);
            return child;
        },
        removeChild(child) {
            element.children = element.children.filter((item) => item !== child);
            child.parentNode = null;
            return child;
        },
        remove() {
            if (element.parentNode) element.parentNode.removeChild(element);
        },
        addEventListener(name, handler) {
            element.events[name] = handler;
        },
        on(names, handler) {
            String(names || '').split(/\s+/).filter(Boolean).forEach((name) => {
                element.events[name] = handler;
            });
        },
        querySelector(selector) {
            return element.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
            const result = [];
            const classSelector = selector.charAt(0) === '.' ? selector.slice(1) : '';
            const idSelector = selector.charAt(0) === '#' ? selector.slice(1) : '';
            const tagSelector = selector.charAt(0) === '.' || selector.charAt(0) === '#'
                ? ''
                : selector.toUpperCase();

            function walk(node) {
                if (classSelector && hasClass(node, classSelector)) result.push(node);
                if (idSelector && node.id === idSelector) result.push(node);
                if (tagSelector && node.tagName === tagSelector) result.push(node);

                node.children.forEach(walk);
            }

            walk(element);
            return result;
        }
    };

    element.classList = {
        add(name) {
            const list = classListOf(element);
            if (list.indexOf(name) === -1) list.push(name);
            element.className = list.join(' ');
        },
        remove(name) {
            element.className = classListOf(element).filter((item) => item !== name).join(' ');
        }
    };

    return element;
}

function createDocument() {
    const head = makeElement('', 'head');

    return {
        head,
        createElement(tag) {
            return makeElement('', tag);
        },
        getElementById(id) {
            return head.querySelector('#' + id);
        }
    };
}

function createTmdbData() {
    return {
        'tv/10': {
            id: 10,
            name: 'Example Show',
            original_name: 'Example Show',
            status: 'Returning Series',
            seasons: [
                { season_number: 0, episode_count: 1 },
                { season_number: 1, episode_count: 2 },
                { season_number: 2, episode_count: 1 },
                { season_number: 3, episode_count: 0 }
            ]
        },
        'tv/10/season/1': {
            episodes: [
                { season_number: 1, episode_number: 1, air_date: '2026-06-01', name: 'One' },
                { season_number: 1, episode_number: 2, air_date: '2026-06-10', name: 'Two' }
            ]
        },
        'tv/10/season/2': {
            episodes: [
                { season_number: 2, episode_number: 1, air_date: '2026-07-01', name: 'Three' }
            ]
        }
    };
}

function createContext(options) {
    options = options || {};

    const storage = makeStorage(options.storage);
    const favoriteState = Object.assign({}, options.favoriteState || {});
    const tmdbData = Object.assign(createTmdbData(), options.tmdbData || {});
    const apiCalls = [];
    const listenerEvents = [];
    const sentEvents = [];
    const timers = [];
    const date = createFakeDate(options.now || '2026-06-15T12:00:00Z');
    const watched = Object.assign({}, options.watched || { '1:1': 95 });
    const card = Object.assign({
        id: 10,
        source: 'tmdb',
        media_type: 'tv',
        name: 'Example Show',
        original_name: 'Example Show'
    }, options.card || {});
    const document = createDocument();

    const context = {
        console,
        Promise,
        Date: date,
        setTimeout(handler, delay) {
            const id = timers.length + 1;
            timers.push({ id, handler, delay, cleared: false });
            return id;
        },
        clearTimeout(id) {
            const timer = timers.find((item) => item.id === id);
            if (timer) timer.cleared = true;
        },
        window: {
            appready: false,
            Lampa: {
                Storage: storage,
                Utils: {
                    hash(value) {
                        return 'hash:' + value;
                    },
                    parseToDate(value) {
                        return new Date(String(value).replace(/-/g, '/'));
                    },
                    clearCard(value) {
                        return Object.assign({}, value);
                    }
                },
                Api: {
                    sources: {
                        tmdb: {
                            get(path, params, success, fail) {
                                apiCalls.push(path);
                                if (tmdbData[path]) success(tmdbData[path]);
                                else fail(new Error('missing ' + path));
                            }
                        }
                    }
                },
                Timeline: {
                    watchedEpisode(item, season, episode, returnTime) {
                        const percent = watched[season + ':' + episode] || 0;
                        return returnTime ? { percent } : percent;
                    },
                    view(hash) {
                        return { percent: watched[String(hash)] || 0 };
                    }
                },
                Favorite: {
                    check(item) {
                        return Object.assign({}, favoriteState[item.id] || {});
                    }
                },
                Listener: {
                    follow(name, handler) {
                        listenerEvents.push(['follow', name, handler]);
                    },
                    remove(name, handler) {
                        listenerEvents.push(['remove', name, handler]);
                    },
                    send(name, payload) {
                        sentEvents.push([name, payload]);
                    }
                },
                Maker: {}
            }
        },
        document
    };

    context.Lampa = context.window.Lampa;
    context.__storage = storage;
    context.__favoriteState = favoriteState;
    context.__tmdbData = tmdbData;
    context.__apiCalls = apiCalls;
    context.__listenerEvents = listenerEvents;
    context.__sentEvents = sentEvents;
    context.__timers = timers;
    context.__date = date;
    context.__watched = watched;
    context.__card = card;

    return context;
}

function loadCounter(context) {
    const source = fs.readFileSync('new_episodes_counter.js', 'utf8').replace(
        /\}\)\(\);\s*$/,
        [
            'window.__newEpisodesCounterTest = {',
            '  PLUGIN_VERSION: PLUGIN_VERSION,',
            '  CACHE_VERSION: CACHE_VERSION,',
            '  CONFIG: CONFIG,',
            '  registerPluginMetadata: registerPluginMetadata,',
            '  freshCache: freshCache,',
            '  validCache: validCache,',
            '  cacheLoad: cacheLoad,',
            '  cacheItem: cacheItem,',
            '  dataCacheGet: dataCacheGet,',
            '  dataCacheSet: dataCacheSet,',
            '  saveAnalysis: saveAnalysis,',
            '  cardKey: cardKey,',
            '  isTvCandidate: isTvCandidate,',
            '  normalizeCard: normalizeCard,',
            '  mergeDetails: mergeDetails,',
            '  getSeasonNumbers: getSeasonNumbers,',
            '  normalizeEpisodeList: normalizeEpisodeList,',
            '  analyzeShow: analyzeShow,',
            '  counterValue: counterValue,',
            '  enqueue: enqueue,',
            '  enqueueByTimelineHash: enqueueByTimelineHash,',
            '  handleStateChanged: handleStateChanged,',
            '  injectStyles: injectStyles,',
            '  renderBadge: renderBadge,',
            '  removeBadge: removeBadge,',
            '  renderAll: renderAll,',
            '  runtime: runtime',
            '};',
            '})();'
        ].join('\n')
    );

    vm.runInNewContext(source, context, { filename: 'new_episodes_counter.js' });
    return context.window.__newEpisodesCounterTest;
}

function makeCardInstance(card) {
    const html = makeElement('card');
    const view = makeElement('card__view');
    const marker = makeElement('card__marker');
    const type = makeElement('card__type');

    marker.textContent = 'Смотрю';
    type.textContent = 'TV';
    view.appendChild(marker);
    view.appendChild(type);
    html.appendChild(view);

    return {
        instance: { data: card, html },
        html,
        view,
        marker,
        type
    };
}

function seedCache(context, counter, items) {
    context.__storage.set('new_episodes_counter_cache', {
        version: counter.CACHE_VERSION,
        pluginVersion: counter.PLUGIN_VERSION,
        updatedAt: context.Date.now(),
        items: items || {},
        data: {}
    });
}

async function runTest(name, fn) {
    try {
        await fn();
        console.log('ok - ' + name);
    } catch (error) {
        error.message = name + ': ' + error.message;
        throw error;
    }
}

(async () => {
    await runTest('cacheLoad creates and repairs cache with current pluginVersion', async () => {
        const context = createContext({ storage: { new_episodes_counter_cache: { version: 1, items: [] } } });
        const counter = loadCounter(context);

        assert.strictEqual(counter.validCache(null), false);
        assert.strictEqual(counter.validCache({ version: 1, items: {}, data: {} }), false);
        assert.strictEqual(counter.validCache({
            version: 1,
            pluginVersion: counter.PLUGIN_VERSION,
            items: {},
            data: {}
        }), true);

        const cache = counter.cacheLoad();
        assert.strictEqual(cache.version, counter.CACHE_VERSION);
        assert.strictEqual(cache.pluginVersion, counter.PLUGIN_VERSION);
        assert.deepStrictEqual(Object.keys(cache.items), []);
        assert.deepStrictEqual(Object.keys(cache.data), []);
        assert.strictEqual(context.__storage.data.new_episodes_counter_cache.pluginVersion, counter.PLUGIN_VERSION);
    });

    await runTest('cacheLoad rejects previous pluginVersion cache', async () => {
        const context = createContext({
            storage: {
                new_episodes_counter_cache: {
                    version: 1,
                    pluginVersion: '0.9.0',
                    updatedAt: Date.now(),
                    items: {
                        'tmdb:10': {
                            key: 'tmdb:10',
                            card: { id: 10 },
                            count: 9,
                            complete: true,
                            hashes: ['old'],
                            updatedAt: Date.now()
                        }
                    },
                    data: {}
                }
            }
        });
        const counter = loadCounter(context);
        const cache = counter.cacheLoad();

        assert.deepStrictEqual(Object.keys(cache.items), []);
        assert.strictEqual(cache.pluginVersion, counter.PLUGIN_VERSION);
        assert.strictEqual(counter.runtime.hashToKey.old, undefined);
    });

    await runTest('cacheLoad hydrates card and timeline hash indexes', async () => {
        const card = { id: 10, source: 'tmdb', media_type: 'tv', original_name: 'Example Show' };
        const context = createContext({
            storage: {
                new_episodes_counter_cache: {
                    version: 1,
                    pluginVersion: '1.0.0',
                    updatedAt: Date.now(),
                    items: {
                        'tmdb:10': {
                            key: 'tmdb:10',
                            card,
                            count: 2,
                            complete: true,
                            hashes: ['hash:1'],
                            updatedAt: Date.now()
                        }
                    },
                    data: {}
                }
            }
        });
        const counter = loadCounter(context);

        counter.cacheLoad();

        assert.strictEqual(counter.runtime.cardByKey['tmdb:10'].id, 10);
        assert.strictEqual(counter.runtime.hashToKey['hash:1'], 'tmdb:10');
        assert.strictEqual(context.__storage.data.new_episodes_counter_cache.pluginVersion, counter.PLUGIN_VERSION);
    });

    await runTest('data cache expires by configured ttl', async () => {
        const context = createContext();
        const counter = loadCounter(context);

        counter.dataCacheSet('sample', { ok: true });
        assert.deepStrictEqual(counter.dataCacheGet('sample'), { ok: true });

        context.__date.advance((counter.CONFIG.cache_ttl_hours * 60 * 60 * 1000) + 1);
        assert.strictEqual(counter.dataCacheGet('sample'), null);
    });

    await runTest('card helpers identify only TMDB-backed TV cards', async () => {
        const counter = loadCounter(createContext());

        assert.strictEqual(counter.cardKey({ id: 10, source: 'cub', media_type: 'tv' }), 'tmdb:10');
        assert.strictEqual(counter.cardKey({ id: 11, source: 'imdb', media_type: 'tv' }), 'imdb:11');
        assert.strictEqual(counter.isTvCandidate({ id: 10, source: 'tmdb', media_type: 'tv' }), true);
        assert.strictEqual(counter.isTvCandidate({ id: 10, source: 'cub', original_name: 'Show' }), true);
        assert.strictEqual(counter.isTvCandidate({ id: 10, source: 'tmdb', media_type: 'movie' }), false);
        assert.strictEqual(counter.isTvCandidate({ id: 10, source: 'imdb', media_type: 'tv' }), false);
    });

    await runTest('analyzeShow counts released unseen episodes and skips specials/future episodes', async () => {
        const context = createContext();
        const counter = loadCounter(context);
        const analysis = await counter.analyzeShow(context.__card);

        assert.strictEqual(analysis.key, 'tmdb:10');
        assert.strictEqual(analysis.count, 1);
        assert.strictEqual(analysis.released, 2);
        assert.strictEqual(analysis.total, 3);
        assert.strictEqual(analysis.first.season_number, 1);
        assert.strictEqual(analysis.first.episode_number, 2);
        assert.deepStrictEqual(Array.from(context.__apiCalls), ['tv/10', 'tv/10/season/1', 'tv/10/season/2']);
        assert.strictEqual(analysis.hashes.indexOf('hash:11Example Show') >= 0, true);
        assert.strictEqual(analysis.hashes.indexOf('hash:12Example Show') >= 0, true);
        assert.strictEqual(analysis.hashes.indexOf('hash:21Example Show') >= 0, true);
    });

    await runTest('analyzeShow treats partial progress below threshold as unseen', async () => {
        const context = createContext({ watched: { '1:1': 5 } });
        const counter = loadCounter(context);
        const analysis = await counter.analyzeShow(context.__card);

        assert.strictEqual(counter.CONFIG.watched_threshold_percent, 90);
        assert.strictEqual(analysis.count, 2);
        assert.strictEqual(analysis.first.season_number, 1);
        assert.strictEqual(analysis.first.episode_number, 1);
    });

    await runTest('analyzeShow uses cached details and episodes on repeated calls', async () => {
        const context = createContext();
        const counter = loadCounter(context);

        await counter.analyzeShow(context.__card);
        await counter.analyzeShow(context.__card);

        assert.deepStrictEqual(Array.from(context.__apiCalls), ['tv/10', 'tv/10/season/1', 'tv/10/season/2']);
    });

    await runTest('counterValue is visible only for look cards with complete cached count', async () => {
        const context = createContext({ favoriteState: { 10: { look: true } } });
        const counter = loadCounter(context);

        seedCache(context, counter, {
            'tmdb:10': {
                key: 'tmdb:10',
                card: context.__card,
                count: 3,
                complete: true,
                hashes: [],
                updatedAt: context.Date.now()
            }
        });

        assert.strictEqual(counter.counterValue(context.__card), 3);

        context.__favoriteState[10] = { continued: true };
        assert.strictEqual(counter.counterValue(context.__card), 0);

        context.__favoriteState[10] = { look: true };
        counter.cacheLoad().items['tmdb:10'].complete = false;
        assert.strictEqual(counter.counterValue(context.__card), 0);
    });

    await runTest('renderBadge replaces TV text, keeps native type style class, and restores cleanly', async () => {
        const context = createContext({ favoriteState: { 10: { look: true } } });
        const counter = loadCounter(context);
        const card = context.__card;
        const dom = makeCardInstance(card);
        const staleSeparateBadge = makeElement('new-episodes-count');

        seedCache(context, counter, {
            'tmdb:10': {
                key: 'tmdb:10',
                card,
                count: 7,
                complete: true,
                hashes: [],
                updatedAt: context.Date.now()
            }
        });

        staleSeparateBadge.textContent = '7';
        dom.view.appendChild(staleSeparateBadge);

        counter.renderBadge(dom.instance);

        assert.strictEqual(dom.type.textContent, '7');
        assert.strictEqual(dom.type.className, 'card__type new-episodes-count');
        assert.strictEqual(dom.type.dataset.newEpisodesOriginalText, 'TV');
        assert.strictEqual(staleSeparateBadge.parentNode, null);

        context.__favoriteState[10] = { continued: true };
        counter.renderBadge(dom.instance);

        assert.strictEqual(dom.type.textContent, 'TV');
        assert.strictEqual(dom.type.className, 'card__type');
        assert.strictEqual(dom.type.dataset.newEpisodesOriginalText, undefined);
    });

    await runTest('renderBadge preserves a non-TV original type label', async () => {
        const context = createContext({ favoriteState: { 10: { look: true } } });
        const counter = loadCounter(context);
        const dom = makeCardInstance(context.__card);

        dom.type.textContent = 'MOV';
        seedCache(context, counter, {
            'tmdb:10': {
                key: 'tmdb:10',
                card: context.__card,
                count: 2,
                complete: true,
                hashes: [],
                updatedAt: context.Date.now()
            }
        });

        counter.renderBadge(dom.instance);
        assert.strictEqual(dom.type.textContent, '2');

        context.__favoriteState[10] = { viewed: true };
        counter.renderBadge(dom.instance);
        assert.strictEqual(dom.type.textContent, 'MOV');
    });

    await runTest('injectStyles adds only sizing and numeric alignment for the counter type badge', async () => {
        const context = createContext();
        const counter = loadCounter(context);

        counter.injectStyles();
        counter.injectStyles();

        const styles = context.document.head.querySelectorAll('style');
        assert.strictEqual(styles.length, 1);
        assert.strictEqual(styles[0].id, 'new-episodes-counter-styles');
        assert.strictEqual(styles[0].textContent.indexOf('min-width:2em;') >= 0, true);
        assert.strictEqual(styles[0].textContent.indexOf('text-align:center;') >= 0, true);
        assert.strictEqual(styles[0].textContent.indexOf('font-variant-numeric:tabular-nums;') >= 0, true);
        assert.strictEqual(styles[0].textContent.indexOf('font-size'), -1);
        assert.strictEqual(styles[0].textContent.indexOf('font-weight'), -1);
    });

    await runTest('enqueue deduplicates queue, respects fresh cache, and supports force', async () => {
        const context = createContext({ favoriteState: { 10: { look: true } } });
        const counter = loadCounter(context);

        seedCache(context, counter, {
            'tmdb:10': {
                key: 'tmdb:10',
                card: context.__card,
                count: 1,
                complete: true,
                hashes: [],
                updatedAt: context.Date.now()
            }
        });

        assert.strictEqual(counter.enqueue(context.__card, 'fresh', false), false);
        assert.strictEqual(counter.enqueue(context.__card, 'force-1', true), true);
        assert.strictEqual(counter.enqueue(context.__card, 'force-2', true), true);
        assert.deepStrictEqual(Array.from(counter.runtime.queue), ['tmdb:10']);
        assert.strictEqual(counter.runtime.queued['tmdb:10'].reason, 'force-2');
        assert.strictEqual(context.__timers.length, 1);
    });

    await runTest('enqueue ignores non-look cards and destroyed runtime', async () => {
        const context = createContext({ favoriteState: { 10: { continued: true } } });
        const counter = loadCounter(context);

        assert.strictEqual(counter.enqueue(context.__card, 'not-look', true), false);

        context.__favoriteState[10] = { look: true };
        counter.runtime.destroyed = true;
        assert.strictEqual(counter.enqueue(context.__card, 'destroyed', true), false);
    });

    await runTest('timeline hash events enqueue the matching cached card', async () => {
        const context = createContext({ favoriteState: { 10: { look: true } } });
        const counter = loadCounter(context);

        seedCache(context, counter, {
            'tmdb:10': {
                key: 'tmdb:10',
                card: context.__card,
                count: 1,
                complete: true,
                hashes: ['hash:12Example Show'],
                updatedAt: context.Date.now()
            }
        });
        counter.cacheLoad();

        counter.enqueueByTimelineHash('hash:12Example Show');
        assert.deepStrictEqual(Array.from(counter.runtime.queue), ['tmdb:10']);
        assert.strictEqual(counter.runtime.queued['tmdb:10'].reason, 'timeline');
    });

    await runTest('unknown timeline hash falls back to unique visible look cards', async () => {
        const context = createContext({ favoriteState: { 10: { look: true }, 11: { look: true } } });
        const counter = loadCounter(context);
        const secondCard = {
            id: 11,
            source: 'tmdb',
            media_type: 'tv',
            name: 'Second Show',
            original_name: 'Second Show'
        };

        counter.runtime.instances.push(
            makeCardInstance(context.__card).instance,
            makeCardInstance(context.__card).instance,
            makeCardInstance(secondCard).instance
        );

        counter.enqueueByTimelineHash('unknown');

        assert.deepStrictEqual(Array.from(counter.runtime.queue).sort(), ['tmdb:10', 'tmdb:11']);
    });

    await runTest('handleStateChanged reacts to favorite and timeline updates without page refresh logic', async () => {
        const context = createContext({ favoriteState: { 10: { look: true } } });
        const counter = loadCounter(context);
        const dom = makeCardInstance(context.__card);

        counter.runtime.instances.push(dom.instance);
        seedCache(context, counter, {
            'tmdb:10': {
                key: 'tmdb:10',
                card: context.__card,
                count: 1,
                complete: true,
                hashes: ['hash:12Example Show'],
                updatedAt: context.Date.now()
            }
        });
        counter.cacheLoad();

        counter.handleStateChanged({ target: 'favorite', type: 'look', card: context.__card });
        assert.strictEqual(counter.runtime.queued['tmdb:10'].reason, 'favorite-look');

        counter.handleStateChanged({ target: 'timeline', reason: 'update', data: { hash: 'hash:12Example Show' } });
        assert.strictEqual(counter.runtime.queued['tmdb:10'].reason, 'timeline');
        assert.strictEqual(counter.runtime.renderTimer > 0, true);
    });

    console.log('new episodes counter tests: ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
