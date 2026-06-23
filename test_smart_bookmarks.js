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
            '  handleFullEvent: handleFullEvent,',
            '  scanFavorites: scanFavorites,',
            '  analyzeAndApply: analyzeAndApply,',
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

function createSmartContext(options = {}) {
    const storage = makeStorage();
    const favoriteState = Object.assign({}, options.favoriteState || {});
    const favoriteCalls = [];
    const watched = Object.assign({ '1:1': 95 }, options.watched || {});
    const favoriteLists = options.favoriteLists || {};
    const pluginList = (options.plugins || []).map((plugin) => Object.assign({}, plugin));
    const pluginSaves = [];
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
                    get(params) {
                        return (favoriteLists[params.type] || []).map((item) => Object.assign({}, item));
                    }
                },
                Plugins: {
                    get() {
                        return pluginList.map((plugin) => plugin);
                    },
                    save() {
                        pluginSaves.push(pluginList.map((plugin) => Object.assign({}, plugin)));
                        storage.set('plugins', pluginList);
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
    context.__plugins = pluginList;
    context.__pluginSaves = pluginSaves;
    context.__card = card;

    return context;
}

(async () => {
    const smartContext = createSmartContext();
    const smart = loadSmartBookmarks(smartContext);
    const card = smartContext.__card;

    assert.strictEqual(smart.PLUGIN_VERSION, '1.0.2');
    assert.strictEqual(smart.validCache({ version: 1, items: {} }), false);
    assert.strictEqual(smart.validCache({ version: 1, pluginVersion: '1.0.2', items: {} }), true);
    smartContext.__plugins.push({
        url: 'https://example.com/plugins/smart_bookmarks.js?v=old',
        status: 1,
        description: 'old',
        version: '1.0.0'
    });
    smart.registerPluginMetadata();
    assert.strictEqual(smartContext.__plugins[0].name, 'Smart Bookmarks');
    assert.strictEqual(smartContext.__plugins[0].author, 'dan7829');
    assert.strictEqual(smartContext.__plugins[0].descr, 'Автоматически поддерживает статусы сериалов в закладках Lampa.');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(smartContext.__plugins[0], 'description'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(smartContext.__plugins[0], 'version'), false);
    assert.strictEqual(smartContext.__pluginSaves.length, 1);
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

    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 1, ended: false, pending: false, complete: true }, 'full'), false);
    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 1, ended: false, pending: false, complete: true }, 'history'), true);
    assert.strictEqual(smart.shouldApplyAnalysis(card, { count: 0, ended: false, pendingInReleasedSeason: false, complete: true }, 'history'), true);
    smart.handleFullEvent({ data: { movie: card } });
    assert.strictEqual(smart.runtime.lastFullCard.id, 10);
    assert.strictEqual(smart.runtime.queue.length, 0);
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

    const historyContinuedContext = createSmartContext({
        favoriteState: { 10: { continued: 10 } },
        favoriteLists: {
            history: [card],
            continued: [card]
        },
        watched: {
            '1:1': 95,
            '1:2': 95
        }
    });
    const historyContinuedSmart = loadSmartBookmarks(historyContinuedContext);
    historyContinuedSmart.scanFavorites();
    assert.deepStrictEqual(historyContinuedContext.__favoriteCalls, []);
    assert.strictEqual(historyContinuedSmart.runtime.queued['tmdb:10'].reason, 'history');
    const historyContinuedAnalysis = await historyContinuedSmart.analyzeAndApply(historyContinuedContext.__card, 'history');
    assert.strictEqual(historyContinuedAnalysis.targetMark, 'continued');
    assert.deepStrictEqual(historyContinuedContext.__favoriteCalls, []);

    smart.dataCacheSet('sample', { ok: true });
    assert.deepStrictEqual(smart.dataCacheGet('sample'), { ok: true });
    assert.strictEqual(smart.cacheLoad().items.sample.updatedAt > 0, true);

    console.log('smart bookmarks tests: ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
