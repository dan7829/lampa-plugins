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

    return FakeDate;
}

function loadSmartBookmarks(context) {
    const source = fs.readFileSync('smart_bookmarks.js', 'utf8').replace(
        /\}\)\(\);\s*$/,
        [
            'window.__smartBookmarksTest = {',
            '  PLUGIN_VERSION: PLUGIN_VERSION,',
            '  CACHE_VERSION: CACHE_VERSION,',
            '  CONFIG: CONFIG,',
            '  SCAN_CATEGORIES: SCAN_CATEGORIES,',
            '  registerPluginMetadata: registerPluginMetadata,',
            '  freshCache: freshCache,',
            '  validCache: validCache,',
            '  cacheLoad: cacheLoad,',
            '  dataCacheGet: dataCacheGet,',
            '  dataCacheSet: dataCacheSet,',
            '  cardKey: cardKey,',
            '  isTvCandidate: isTvCandidate,',
            '  normalizeCard: normalizeCard,',
            '  mergeDetails: mergeDetails,',
            '  getSeasonNumbers: getSeasonNumbers,',
            '  normalizeEpisodeList: normalizeEpisodeList,',
            '  releasedEpisodes: releasedEpisodes,',
            '  hasPendingKnownEpisodes: hasPendingKnownEpisodes,',
            '  latestReleasedSeason: latestReleasedSeason,',
            '  hasPendingInReleasedSeason: hasPendingInReleasedSeason,',
            '  targetMarkForAnalysis: targetMarkForAnalysis,',
            '  shouldApplyAnalysis: shouldApplyAnalysis,',
            '  setFavoriteMark: setFavoriteMark,',
            '  analyzeShow: analyzeShow,',
            '  runtime: runtime',
            '};',
            '})();'
        ].join('\n')
    );

    vm.runInNewContext(source, context, { filename: 'smart_bookmarks.js' });
    return context.window.__smartBookmarksTest;
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
            '  dataCacheGet: dataCacheGet,',
            '  dataCacheSet: dataCacheSet,',
            '  cardKey: cardKey,',
            '  isTvCandidate: isTvCandidate,',
            '  normalizeCard: normalizeCard,',
            '  mergeDetails: mergeDetails,',
            '  getSeasonNumbers: getSeasonNumbers,',
            '  normalizeEpisodeList: normalizeEpisodeList,',
            '  analyzeShow: analyzeShow,',
            '  cacheItem: cacheItem,',
            '  counterValue: counterValue,',
            '  enqueue: enqueue,',
            '  enqueueByTimelineHash: enqueueByTimelineHash,',
            '  renderBadge: renderBadge,',
            '  removeBadge: removeBadge,',
            '  runtime: runtime',
            '};',
            '})();'
        ].join('\n')
    );

    vm.runInNewContext(source, context, { filename: 'new_episodes_counter.js' });
    return context.window.__newEpisodesCounterTest;
}

function makeStorage() {
    const data = {};

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

function makeElement(className, tagName = 'div') {
    const element = {
        className: className || '',
        tagName: String(tagName || 'div').toUpperCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        textContent: '',
        appendChild(child) {
            child.parentNode = element;
            element.children.push(child);
            return child;
        },
        remove() {
            if (!element.parentNode) return;
            element.parentNode.children = element.parentNode.children.filter((child) => child !== element);
            element.parentNode = null;
        },
        querySelector(selector) {
            return element.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
            const result = [];
            const classSelector = selector.charAt(0) === '.' ? selector.slice(1) : '';
            const tagSelector = selector.charAt(0) === '.' ? '' : selector.toUpperCase();

            function walk(node) {
                if (
                    classSelector &&
                    String(node.className || '').split(/\s+/).indexOf(classSelector) !== -1
                ) {
                    result.push(node);
                }

                if (tagSelector && node.tagName === tagSelector) result.push(node);

                node.children.forEach(walk);
            }

            walk(element);
            return result;
        }
    };

    element.classList = {
        add(name) {
            const list = String(element.className || '').split(/\s+/).filter(Boolean);
            if (list.indexOf(name) === -1) list.push(name);
            element.className = list.join(' ');
        },
        remove(name) {
            element.className = String(element.className || '')
                .split(/\s+/)
                .filter((item) => item && item !== name)
                .join(' ');
        }
    };

    return element;
}

function createSmartContext(options = {}) {
    const storage = makeStorage();
    const favoriteState = {};
    const favoriteCalls = [];
    const watched = Object.assign({ '1:1': 95 }, options.watched || {});
    const card = {
        id: 10,
        source: 'tmdb',
        media_type: 'tv',
        name: 'Example Show',
        original_name: 'Example Show'
    };

    const tmdbData = {
        'tv/10': {
            id: 10,
            name: 'Example Show',
            original_name: 'Example Show',
            status: 'Returning Series',
            seasons: [
                { season_number: 0, episode_count: 1 },
                { season_number: 1, episode_count: 2 },
                { season_number: 2, episode_count: 1 }
            ]
        },
        'tv/10/season/1': {
            episodes: [
                { season_number: 1, episode_number: 1, air_date: '2026-06-01', name: 'One' },
                { season_number: 1, episode_number: 2, air_date: '2026-06-02', name: 'Two' }
            ]
        },
        'tv/10/season/2': {
            episodes: [
                { season_number: 2, episode_number: 1, air_date: '2026-07-01', name: 'Three' }
            ]
        }
    };

    const context = {
        console,
        Promise,
        Date: createFakeDate(),
        setTimeout: () => 0,
        clearTimeout: () => {},
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
                    }
                },
                Favorite: {
                    check(item) {
                        return Object.assign({ any: false }, favoriteState[item.id] || {});
                    },
                    add(type, item) {
                        favoriteCalls.push(['add', type, item.id]);
                        favoriteState[item.id] = Object.assign({}, favoriteState[item.id], { [type]: item.id });
                    },
                    remove(type, item) {
                        favoriteCalls.push(['remove', type, item.id]);
                        if (favoriteState[item.id]) delete favoriteState[item.id][type];
                    },
                    get() {
                        return [];
                    }
                },
                Listener: {
                    follow() {},
                    remove() {},
                    send() {}
                }
            }
        }
    };

    context.Lampa = context.window.Lampa;
    context.__storage = storage;
    context.__favoriteState = favoriteState;
    context.__favoriteCalls = favoriteCalls;
    context.__watched = watched;
    context.__card = card;

    return context;
}

function createCounterContext() {
    const storage = makeStorage();
    const favoriteState = {};
    const card = {
        id: 10,
        source: 'tmdb',
        media_type: 'tv',
        name: 'Example Show',
        original_name: 'Example Show'
    };
    const tmdbData = {
        'tv/10': {
            id: 10,
            name: 'Example Show',
            original_name: 'Example Show',
            status: 'Returning Series',
            seasons: [
                { season_number: 0, episode_count: 1 },
                { season_number: 1, episode_count: 2 },
                { season_number: 2, episode_count: 1 }
            ]
        },
        'tv/10/season/1': {
            episodes: [
                { season_number: 1, episode_number: 1, air_date: '2026-06-01', name: 'One' },
                { season_number: 1, episode_number: 2, air_date: '2026-06-02', name: 'Two' }
            ]
        },
        'tv/10/season/2': {
            episodes: [
                { season_number: 2, episode_number: 1, air_date: '2026-07-01', name: 'Three' }
            ]
        }
    };
    const context = {
        console,
        Promise,
        Date: createFakeDate(),
        setTimeout: () => 0,
        clearTimeout: () => {},
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
                                if (tmdbData[path]) success(tmdbData[path]);
                                else fail(new Error('missing ' + path));
                            }
                        }
                    }
                },
                Timeline: {
                    watchedEpisode(item, season, episode, returnTime) {
                        const percent = season === 1 && episode === 1 ? 95 : 0;
                        return returnTime ? { percent } : percent;
                    }
                },
                Favorite: {
                    check(card) {
                        return favoriteState[card.id] || {};
                    }
                },
                Listener: {
                    follow() {},
                    remove() {}
                },
                Maker: {}
            }
        },
        document: {
            createElement: (tag) => makeElement(tag),
            getElementById: () => null,
            head: makeElement('head')
        }
    };

    context.Lampa = context.window.Lampa;
    context.__storage = storage;
    context.__favoriteState = favoriteState;
    context.__card = card;

    return context;
}

(async () => {
    const smartContext = createSmartContext();
    const smart = loadSmartBookmarks(smartContext);
    const card = smartContext.__card;

    assert.strictEqual(smart.PLUGIN_VERSION, '1.0.0');
    assert.strictEqual(smart.validCache({ version: 1, items: {} }), false);
    assert.strictEqual(smart.validCache({ version: 1, pluginVersion: '1.0.0', items: {} }), true);
    smartContext.__storage.set('plugins', [{ url: 'https://example.com/plugins/smart_bookmarks.js?v=old', status: 1 }]);
    smart.registerPluginMetadata();
    assert.strictEqual(smartContext.__storage.data.plugins[0].name, 'Smart Bookmarks');
    assert.strictEqual(smartContext.__storage.data.plugins[0].author, 'dan7829');
    assert.strictEqual(smartContext.__storage.data.plugins[0].descr, 'Автоматически поддерживает статусы сериалов в закладках Lampa.');
    assert.strictEqual(smartContext.__storage.data.plugins[0].description, 'Автоматически поддерживает статусы сериалов в закладках Lampa.');
    assert.strictEqual(smartContext.__storage.data.plugins[0].version, '1.0.0');
    assert.strictEqual(smart.cardKey(card), 'tmdb:10');
    assert.strictEqual(smart.isTvCandidate(card), true);
    assert.strictEqual(smart.isTvCandidate({ id: 11, source: 'tmdb', method: 'movie' }), false);
    assert.strictEqual(Array.from(smart.SCAN_CATEGORIES).indexOf('viewed'), -1);

    assert.deepStrictEqual(
        Array.from(smart.getSeasonNumbers(card, {
            seasons: [
                { season_number: 0, episode_count: 1 },
                { season_number: 1, episode_count: 2 },
                { season_number: 2, episode_count: 0 },
                { season_number: 3, episode_count: 1 }
            ]
        })),
        [1, 3]
    );

    assert.strictEqual(smart.targetMarkForAnalysis({ count: 2, ended: false }), 'look');
    assert.strictEqual(smart.targetMarkForAnalysis({ count: 0, ended: true }), 'viewed');
    assert.strictEqual(smart.targetMarkForAnalysis({ count: 0, ended: false, pendingInReleasedSeason: false }), 'continued');
    assert.strictEqual(smart.targetMarkForAnalysis({ count: 0, ended: false, pendingInReleasedSeason: true }), '');

    const currentSeasonPending = [
        { season_number: 1, episode_number: 1, air_date: '2026-06-01' },
        { season_number: 1, episode_number: 2, air_date: '2026-07-01' }
    ];
    const nextSeasonPending = [
        { season_number: 1, episode_number: 1, air_date: '2026-06-01' },
        { season_number: 2, episode_number: 1, air_date: '2026-07-01' }
    ];

    assert.strictEqual(smart.latestReleasedSeason(currentSeasonPending), 1);
    assert.strictEqual(smart.hasPendingInReleasedSeason(currentSeasonPending), true);
    assert.strictEqual(smart.hasPendingInReleasedSeason(nextSeasonPending), false);

    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 1, ended: false, pending: false, complete: true }, 'history'), true);
    smartContext.__favoriteState[10] = { viewed: 10 };
    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 1, ended: false, pending: false, complete: true }, 'history'), false);
    smartContext.__favoriteState[10] = { look: 10 };
    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 0, ended: false, pendingInReleasedSeason: true, complete: true }, 'scan'), false);
    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 0, ended: false, pendingInReleasedSeason: false, complete: true }, 'scan'), true);

    smartContext.__favoriteState[10] = { continued: 10 };
    assert.strictEqual(smart.setFavoriteMark(card, 'look'), true);
    assert.deepStrictEqual(smartContext.__favoriteCalls, [
        ['remove', 'continued', 10],
        ['add', 'look', 10]
    ]);

    const analysis = await smart.analyzeShow(card);
    assert.strictEqual(analysis.key, 'tmdb:10');
    assert.strictEqual(analysis.count, 1);
    assert.strictEqual(analysis.released, 2);
    assert.strictEqual(analysis.total, 3);
    assert.strictEqual(analysis.first.episode_number, 2);
    assert.strictEqual(analysis.next.episode_number, 1);
    assert.strictEqual(analysis.pending, true);
    assert.strictEqual(analysis.pendingInReleasedSeason, false);

    const partialSmartContext = createSmartContext({ watched: { '1:1': 5 } });
    const partialSmart = loadSmartBookmarks(partialSmartContext);
    const partialSmartAnalysis = await partialSmart.analyzeShow(partialSmartContext.__card);
    assert.strictEqual(partialSmartAnalysis.count, 2);
    assert.strictEqual(partialSmartAnalysis.first.episode_number, 1);

    smart.dataCacheSet('sample', { ok: true });
    assert.deepStrictEqual(smart.dataCacheGet('sample'), { ok: true });
    assert.strictEqual(smart.cacheLoad().items.sample.updatedAt > 0, true);

    const counterContext = createCounterContext();
    const counter = loadCounter(counterContext);
    const html = makeElement('card');
    const view = makeElement('card__view');
    const marker = makeElement('card__marker');
    marker.textContent = 'Смотрю';
    const typeBadge = makeElement('card__type');
    typeBadge.textContent = 'TV';
    view.appendChild(marker);
    view.appendChild(typeBadge);
    html.appendChild(view);
    const instance = { data: card, html };

    assert.strictEqual(counter.PLUGIN_VERSION, '1.0.0');
    assert.strictEqual(counter.CACHE_VERSION, 1);
    counterContext.__storage.set('plugins', [{ url: 'https://example.com/plugins/new_episodes_counter.js?v=old', status: 1 }]);
    counter.registerPluginMetadata();
    assert.strictEqual(counterContext.__storage.data.plugins[0].name, 'New Episodes Counter');
    assert.strictEqual(counterContext.__storage.data.plugins[0].author, 'dan7829');
    assert.strictEqual(counterContext.__storage.data.plugins[0].descr, 'Показывает на карточках сериалов количество вышедших непросмотренных серий.');
    assert.strictEqual(counterContext.__storage.data.plugins[0].description, 'Показывает на карточках сериалов количество вышедших непросмотренных серий.');
    assert.strictEqual(counterContext.__storage.data.plugins[0].version, '1.0.0');
    assert.strictEqual(counter.cardKey(card), 'tmdb:10');
    assert.strictEqual(counter.isTvCandidate(card), true);

    counterContext.__storage.set('new_episodes_counter_cache', {
        version: 1,
        pluginVersion: '1.0.0',
        updatedAt: Date.now(),
        items: {
            'tmdb:10': {
                key: 'tmdb:10',
                card,
                count: 3,
                complete: true,
                hashes: ['hash:12Example Show'],
                updatedAt: Date.now()
            }
        },
        data: {}
    });
    counterContext.__favoriteState[10] = { look: true };

    assert.strictEqual(counter.counterValue(card), 3);
    assert.strictEqual(counter.runtime.hashToKey['hash:12Example Show'], 'tmdb:10');
    typeBadge.textContent = '3';
    typeBadge.dataset.newEpisodesOriginalText = 'TV';
    typeBadge.classList.add('new-episodes-count');
    const staleSeparateBadge = makeElement('new-episodes-count');
    staleSeparateBadge.textContent = '3';
    view.appendChild(staleSeparateBadge);
    counter.renderBadge(instance);
    const countBadge = view.querySelector('.new-episodes-count');
    assert.strictEqual(typeBadge.textContent, '3');
    assert.strictEqual(typeBadge.className, 'card__type new-episodes-count');
    assert.strictEqual(marker.textContent, 'Смотрю');
    assert.strictEqual(countBadge, typeBadge);
    assert.strictEqual(staleSeparateBadge.parentNode, null);

    counterContext.__favoriteState[10] = { continued: true };
    counter.renderBadge(instance);
    assert.strictEqual(typeBadge.textContent, 'TV');
    assert.strictEqual(typeBadge.className, 'card__type');
    assert.strictEqual(view.querySelector('.new-episodes-count'), null);

    counterContext.__favoriteState[10] = { look: true };
    const counterAnalysis = await counter.analyzeShow(counterContext.__card);
    assert.strictEqual(counterAnalysis.key, 'tmdb:10');
    assert.strictEqual(counterAnalysis.count, 1);
    assert.strictEqual(counterAnalysis.released, 2);
    assert.strictEqual(counterAnalysis.total, 3);
    assert.strictEqual(counterAnalysis.hashes.indexOf('hash:12Example Show') >= 0, true);

    counter.dataCacheSet('sample', { ok: true });
    assert.strictEqual(counter.dataCacheGet('sample').ok, true);
    assert.strictEqual(counter.cacheLoad().data.sample.updatedAt > 0, true);
    assert.strictEqual(counter.enqueue(counterContext.__card, 'test', true), true);

    console.log('smart plugin tests: ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
