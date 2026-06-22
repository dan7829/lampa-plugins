(function () {
    'use strict';

    /**
     * Smart Bookmarks автоматически поддерживает статусы сериалов в Lampa.
     *
     * Что делает плагин:
     * - переносит сериал в "Я смотрю", когда он появляется в истории просмотра
     *   или когда у него есть вышедшие непросмотренные серии;
     * - переносит полностью просмотренный завершенный сериал в "Просмотрено";
     * - переносит полностью просмотренный онгоинг в "Продолжение следует"
     *   только когда текущий вышедший сезон действительно закончился;
     * - считает "Просмотрено" терминальным решением пользователя и не переносит
     *   такой сериал обратно в "Я смотрю" автоматически.
     *
     * Плагин использует только штатные API Lampa: Favorite, Timeline и TMDB.
     */

    var PLUGIN_VERSION = '1.0.2';
    var PLUGIN_NAME = 'Smart Bookmarks';
    var PLUGIN_AUTHOR = 'dan7829';
    var PLUGIN_DESCRIPTION = 'Автоматически поддерживает статусы сериалов в закладках Lampa.';
    var PLUGIN_FILE_NAME = 'smart_bookmarks.js';
    var PLUGIN_ID = 'smart_bookmarks_' + safeVersionSuffix(PLUGIN_VERSION);
    var RUNTIME_KEY = 'smart_bookmarks_runtime';
    var CACHE_KEY = 'smart_bookmarks_cache';
    var CACHE_VERSION = 1;

    if (window[PLUGIN_ID]) return;
    window[PLUGIN_ID] = true;

    var previousRuntime = window[RUNTIME_KEY];

    if (previousRuntime && typeof previousRuntime.destroy === 'function') {
        try {
            previousRuntime.destroy();
        } catch (e) {}
    }

    var CONFIG = {
        max_seasons: 120,
        skip_specials: true,
        delay_hours: 0,
        cache_ttl_hours: 12,
        startup_delay_ms: 2500,
        queue_delay_ms: 250,
        mutation_cooldown_ms: 5000,
        current_full_ttl_ms: 1000 * 60 * 30,
        watched_threshold_percent: 90,
        debug: false
    };

    var MARKS = ['look', 'viewed', 'scheduled', 'continued', 'thrown'];
    var SCAN_CATEGORIES = ['history', 'look', 'continued'];
    var cacheState = null;

    var runtime = {
        destroyed: false,
        started: false,
        stateListener: null,
        fullListener: null,
        appListener: null,
        startupTimer: 0,
        queueTimer: 0,
        running: false,
        queue: [],
        queued: {},
        hashToKey: {},
        lastFullCard: null,
        lastFullAt: 0,
        mutations: {},
        destroy: null
    };

    window[RUNTIME_KEY] = runtime;

    function safeVersionSuffix(version) {
        return String(version || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '0';
    }

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[SmartBookmarks v' + PLUGIN_VERSION + ']');
            console.log.apply(console, args);
        } catch (e) {}
    }

    function debug() {
        if (CONFIG.debug) log.apply(null, arguments);
    }

    function clone(object) {
        var result = {};
        object = object || {};

        Object.keys(object).forEach(function (key) {
            result[key] = object[key];
        });

        return result;
    }

    function storageGet(key, fallback) {
        try {
            if (window.Lampa && Lampa.Storage && Lampa.Storage.get) {
                var value = Lampa.Storage.get(key, fallback);

                if (typeof value === 'string') {
                    try {
                        return JSON.parse(value);
                    } catch (e) {
                        return value;
                    }
                }

                return value;
            }
        } catch (e2) {}

        return fallback;
    }

    function storageSet(key, value) {
        try {
            if (window.Lampa && Lampa.Storage && Lampa.Storage.set) Lampa.Storage.set(key, value);
        } catch (e) {}
    }

    function cleanPluginUrl(url) {
        return String(url || '').split('#')[0].split('?')[0].replace(/\/+$/g, '');
    }

    function currentPluginUrl() {
        try {
            var script = document.currentScript;
            if (script) return script.src || (script.getAttribute ? script.getAttribute('src') : '') || '';
        } catch (e) {}

        return PLUGIN_FILE_NAME;
    }

    function samePluginUrl(left, right) {
        var a = cleanPluginUrl(left);
        var b = cleanPluginUrl(right);

        if (!a || !b) return false;
        if (a === b) return true;

        return a.split('/').pop() === b.split('/').pop();
    }

    function registerPluginMetadata() {
        try {
            if (!window.Lampa || !Lampa.Plugins || !Lampa.Plugins.get || !Lampa.Plugins.save) return;

            var currentUrl = currentPluginUrl();
            var changed = false;

            Lampa.Plugins.get().forEach(function (plugin) {
                if (!plugin || typeof plugin !== 'object' || !plugin.url || !samePluginUrl(plugin.url, currentUrl)) return;

                if (plugin.name !== PLUGIN_NAME) {
                    plugin.name = PLUGIN_NAME;
                    changed = true;
                }

                if (plugin.author !== PLUGIN_AUTHOR) {
                    plugin.author = PLUGIN_AUTHOR;
                    changed = true;
                }

                if (plugin.descr !== PLUGIN_DESCRIPTION) {
                    plugin.descr = PLUGIN_DESCRIPTION;
                    changed = true;
                }

                if (Object.prototype.hasOwnProperty.call(plugin, 'description')) {
                    delete plugin.description;
                    changed = true;
                }

                if (Object.prototype.hasOwnProperty.call(plugin, 'version')) {
                    delete plugin.version;
                    changed = true;
                }
            });

            if (changed) Lampa.Plugins.save();
        } catch (e) {
            debug('plugin metadata sync failed', e);
        }
    }

    function freshCache() {
        return {
            version: CACHE_VERSION,
            pluginVersion: PLUGIN_VERSION,
            updatedAt: 0,
            items: {}
        };
    }

    function validCache(cache) {
        return !!(
            cache &&
            cache.version === CACHE_VERSION &&
            cache.pluginVersion === PLUGIN_VERSION &&
            cache.items &&
            typeof cache.items === 'object' &&
            !Array.isArray(cache.items)
        );
    }

    function cacheLoad() {
        if (cacheState) return cacheState;

        var saved = storageGet(CACHE_KEY, null);

        if (!validCache(saved)) {
            saved = freshCache();
            cacheState = saved;
            cacheSave();
        } else {
            cacheState = saved;
            cacheState.pluginVersion = PLUGIN_VERSION;
            cachePrune();
        }

        return cacheState;
    }

    function cacheSave() {
        if (!cacheState) return;
        cacheState.pluginVersion = PLUGIN_VERSION;
        cacheState.updatedAt = Date.now();
        storageSet(CACHE_KEY, cacheState);
    }

    function cacheTtlMs() {
        return Number(CONFIG.cache_ttl_hours || 12) * 60 * 60 * 1000;
    }

    function cachePrune() {
        var cache = cacheLoad();
        var ttl = cacheTtlMs();
        var now = Date.now();
        var changed = false;

        Object.keys(cache.items).forEach(function (key) {
            var item = cache.items[key];

            if (!item || !item.updatedAt || now - item.updatedAt > ttl * 4) {
                delete cache.items[key];
                changed = true;
            }
        });

        if (changed) cacheSave();
    }

    function cacheItem(key) {
        var cache = cacheLoad();
        return cache.items[key] || null;
    }

    function saveAnalysis(analysis) {
        if (!analysis || !analysis.key) return;

        var cache = cacheLoad();

        cache.items[analysis.key] = {
            key: analysis.key,
            card: clearCard(analysis.card),
            count: analysis.count,
            released: analysis.released,
            total: analysis.total,
            first: analysis.first || null,
            next: analysis.next || null,
            ended: analysis.ended,
            complete: analysis.complete !== false,
            status: analysis.targetMark || '',
            updatedAt: Date.now(),
            error: analysis.error || ''
        };

        cacheSave();
        sendStateChanged('update', analysis.card, analysis.key);
    }

    function clearCard(card) {
        try {
            if (window.Lampa && Lampa.Utils && Lampa.Utils.clearCard) return Lampa.Utils.clearCard(clone(card));
        } catch (e) {}

        return clone(card);
    }

    function cardSource(card) {
        return String((card && card.source) || 'tmdb').toLowerCase();
    }

    function isTmdbBackedCard(card) {
        var source = cardSource(card);
        return source === 'tmdb' || source === 'cub';
    }

    function cardKey(card) {
        if (!card || !card.id) return '';
        return (isTmdbBackedCard(card) ? 'tmdb' : cardSource(card)) + ':' + String(card.id);
    }

    function isTvCandidate(card) {
        if (!card || !card.id || !isTmdbBackedCard(card)) return false;
        if (card.media_type === 'movie' || card.method === 'movie') return false;

        return !!(
            card.media_type === 'tv' ||
            card.method === 'tv' ||
            card.original_name ||
            card.name ||
            card.number_of_seasons ||
            card.first_air_date
        );
    }

    function normalizeCard(card) {
        var data = clone(card);

        if (data.name) data.title = data.name;
        if (data.original_name) data.original_title = data.original_name;
        if (data.first_air_date) data.release_date = data.first_air_date;
        if (!data.source) data.source = 'tmdb';

        return data;
    }

    function mergeDetails(card, details) {
        var result = normalizeCard(card);
        details = details || {};

        [
            'poster_path',
            'backdrop_path',
            'vote_average',
            'number_of_seasons',
            'number_of_episodes',
            'first_air_date',
            'last_air_date',
            'original_language',
            'status',
            'next_episode_to_air'
        ].forEach(function (key) {
            if (typeof result[key] === 'undefined' && typeof details[key] !== 'undefined') result[key] = details[key];
        });

        if (!result.name && details.name) result.name = details.name;
        if (!result.title && result.name) result.title = result.name;
        if (!result.original_name && details.original_name) result.original_name = details.original_name;
        if (!result.original_title && result.original_name) result.original_title = result.original_name;
        if (!result.first_air_date && details.first_air_date) result.first_air_date = details.first_air_date;
        if (!result.release_date && result.first_air_date) result.release_date = result.first_air_date;
        if (!result.source) result.source = 'tmdb';

        return result;
    }

    function titleOf(card) {
        return (card && (card.title || card.name || card.original_title || card.original_name)) || 'Untitled';
    }

    function parseDateMs(date) {
        if (!date) return 0;

        try {
            if (window.Lampa && Lampa.Utils && Lampa.Utils.parseToDate) {
                var nativeDate = Lampa.Utils.parseToDate(date);
                var nativeTime = nativeDate ? nativeDate.getTime() : 0;
                if (!isNaN(nativeTime)) return nativeTime;
            }
        } catch (e) {}

        var time = new Date(String(date).split('T')[0] + 'T00:00:00').getTime();
        return isNaN(time) ? 0 : time;
    }

    function isReleased(episode) {
        var time = parseDateMs(episode && episode.air_date);
        if (!time) return false;
        return time + Number(CONFIG.delay_hours || 0) * 60 * 60 * 1000 <= Date.now();
    }

    function isFutureEpisode(episode) {
        var time = parseDateMs(episode && episode.air_date);
        return time > Date.now();
    }

    function sortEpisodes(episodes) {
        return (episodes || []).sort(function (a, b) {
            if (a.season !== b.season) return a.season - b.season;
            if (a.episode !== b.episode) return a.episode - b.episode;
            return String(a.air_date || '').localeCompare(String(b.air_date || ''));
        });
    }

    function statusText(card, details) {
        return String((details && details.status) || (card && card.status) || '').toLowerCase();
    }

    function isEndedShow(card, details) {
        var status = statusText(card, details);

        if (!status) return false;
        if (/ended|canceled|cancelled|final|заверш|закрыт|отмен/.test(status)) return true;

        return false;
    }

    function tmdbGet(path) {
        return new Promise(function (resolve, reject) {
            try {
                if (!window.Lampa || !Lampa.Api || !Lampa.Api.sources || !Lampa.Api.sources.tmdb || !Lampa.Api.sources.tmdb.get) {
                    reject(new Error('TMDB API not available'));
                    return;
                }

                var done = false;

                function success(json) {
                    if (done) return;

                    if (!json || typeof json !== 'object' || Array.isArray(json) || json.success === false || json.status_code) {
                        fail(new Error('Bad TMDB response: ' + path));
                        return;
                    }

                    done = true;
                    resolve(json);
                }

                function fail(error) {
                    if (done) return;
                    done = true;
                    reject(error || new Error('TMDB request failed: ' + path));
                }

                Lampa.Api.sources.tmdb.get(path, {}, success, fail);
            } catch (e) {
                reject(e);
            }
        });
    }

    function dataCacheGet(key) {
        var item = cacheItem(key);
        if (!item || !item.dataAt || Date.now() - item.dataAt > cacheTtlMs()) return null;
        return item.data || null;
    }

    function dataCacheSet(key, data) {
        var cache = cacheLoad();
        var item = cache.items[key] || {};

        item.key = key;
        item.data = data;
        item.dataAt = Date.now();
        item.updatedAt = item.dataAt;
        cache.items[key] = item;
        cacheSave();
    }

    function loadDetails(card) {
        var key = 'details:' + cardKey(card);
        var cached = dataCacheGet(key);

        if (cached) return Promise.resolve(cached);

        return tmdbGet('tv/' + card.id).then(function (details) {
            dataCacheSet(key, details);
            return details;
        });
    }

    function getSeasonNumbers(card, details) {
        var seasonNumbers = [];
        var seasons = (details && details.seasons) || [];
        var i;

        if (seasons.length) {
            for (i = 0; i < seasons.length; i++) {
                var season = seasons[i];

                if (!season) continue;
                if (typeof season.season_number === 'undefined') continue;
                if (CONFIG.skip_specials && Number(season.season_number) === 0) continue;
                if (Number(season.episode_count || 0) <= 0) continue;

                seasonNumbers.push(Number(season.season_number));
            }
        } else {
            var count = Number((details && details.number_of_seasons) || card.number_of_seasons || 0);
            for (i = 1; i <= count; i++) seasonNumbers.push(i);
        }

        return seasonNumbers.slice(0, Number(CONFIG.max_seasons || 120));
    }

    function normalizeEpisodeList(list) {
        var episodes = [];

        (list || []).forEach(function (episode) {
            if (!episode) return;

            var seasonNumber = Number(episode.season_number || episode.season || 0);
            var episodeNumber = Number(episode.episode_number || episode.episode || 0);

            if (!seasonNumber || !episodeNumber) return;

            episodes.push({
                season: seasonNumber,
                episode: episodeNumber,
                season_number: seasonNumber,
                episode_number: episodeNumber,
                name: episode.name || '',
                air_date: episode.air_date || '',
                runtime: episode.runtime,
                still_path: episode.still_path || ''
            });
        });

        return sortEpisodes(episodes);
    }

    function loadEpisodesFromTmdb(card, details) {
        var seasonNumbers = getSeasonNumbers(card, details || {});
        var episodes = [];
        var chain = Promise.resolve();

        seasonNumbers.forEach(function (seasonNumber) {
            chain = chain.then(function () {
                return tmdbGet('tv/' + card.id + '/season/' + seasonNumber).then(function (seasonData) {
                    (seasonData.episodes || []).forEach(function (episode) {
                        if (!episode || typeof episode.episode_number === 'undefined') return;

                        episodes.push({
                            season: seasonNumber,
                            episode: Number(episode.episode_number),
                            season_number: seasonNumber,
                            episode_number: Number(episode.episode_number),
                            name: episode.name || '',
                            air_date: episode.air_date || '',
                            runtime: episode.runtime,
                            still_path: episode.still_path || ''
                        });
                    });
                });
            });
        });

        return chain.then(function () {
            return normalizeEpisodeList(episodes);
        });
    }

    function loadEpisodes(card, details) {
        var key = 'episodes:' + cardKey(card);
        var cached = dataCacheGet(key);

        if (cached) return Promise.resolve(cached);

        return loadEpisodesFromTmdb(card, details).then(function (episodes) {
            dataCacheSet(key, episodes);
            return episodes;
        });
    }

    function hash(value) {
        try {
            if (window.Lampa && Lampa.Utils && Lampa.Utils.hash) return Lampa.Utils.hash(String(value));
        } catch (e) {}

        return null;
    }

    function episodeHash(card, episode) {
        var seasonNumber = Number(episode.season_number || episode.season || 0);
        var episodeNumber = Number(episode.episode_number || episode.episode || 0);
        var originalName = card && (card.original_name || card.original_title);

        if (!seasonNumber || !episodeNumber || !originalName) return null;

        return hash([seasonNumber, seasonNumber > 10 ? ':' : '', episodeNumber, originalName].join(''));
    }

    function timelinePercent(timeline) {
        if (!timeline) return 0;
        if (typeof timeline === 'number') return Number(timeline) || 0;
        if (typeof timeline.percent !== 'undefined') return Number(timeline.percent) || 0;
        if (timeline.view && typeof timeline.view.percent !== 'undefined') return Number(timeline.view.percent) || 0;
        return 0;
    }

    function isWatchedPercent(percent) {
        return Number(percent || 0) >= Number(CONFIG.watched_threshold_percent || 90);
    }

    function isEpisodeViewed(card, episode) {
        try {
            if (window.Lampa && Lampa.Timeline && Lampa.Timeline.watchedEpisode) {
                return isWatchedPercent(timelinePercent(Lampa.Timeline.watchedEpisode(card, episode.season_number, episode.episode_number, true)));
            }
        } catch (e) {}

        try {
            if (window.Lampa && Lampa.Timeline && Lampa.Timeline.view) {
                var epHash = episodeHash(card, episode);
                if (epHash || epHash === 0) return isWatchedPercent(timelinePercent(Lampa.Timeline.view(epHash)));
            }
        } catch (e2) {}

        return false;
    }

    function favoriteStatus(card) {
        try {
            if (window.Lampa && Lampa.Favorite && Lampa.Favorite.check) return Lampa.Favorite.check(card) || {};
        } catch (e) {}

        return {};
    }

    function currentMark(status) {
        var found = '';

        MARKS.some(function (mark) {
            if (status && status[mark]) {
                found = mark;
                return true;
            }

            return false;
        });

        return found;
    }

    function setFavoriteMark(card, target) {
        if (!card || !target) return false;

        var key = cardKey(card);
        var now = Date.now();
        var mutation = runtime.mutations[key];

        if (mutation && mutation.target === target && now - mutation.time < CONFIG.mutation_cooldown_ms) return false;

        var status = favoriteStatus(card);
        if (status[target]) return false;

        runtime.mutations[key] = { target: target, time: now };

        try {
            MARKS.forEach(function (mark) {
                if (mark !== target && status[mark] && Lampa.Favorite && Lampa.Favorite.remove) {
                    Lampa.Favorite.remove(mark, card);
                }
            });

            if (window.Lampa && Lampa.Favorite && Lampa.Favorite.add) {
                Lampa.Favorite.add(target, card);
                debug('mark set', target, titleOf(card));
                return true;
            }
        } catch (e) {
            log('favorite mark failed', target, titleOf(card), e);
        }

        return false;
    }

    function releasedEpisodes(episodes) {
        return sortEpisodes((episodes || []).filter(isReleased));
    }

    function nextFutureEpisode(episodes) {
        return sortEpisodes((episodes || []).filter(isFutureEpisode))[0] || null;
    }

    function hasPendingKnownEpisodes(episodes) {
        return (episodes || []).some(function (episode) {
            return !episode.air_date || !isReleased(episode);
        });
    }

    function latestReleasedSeason(episodes) {
        var season = 0;

        (episodes || []).forEach(function (episode) {
            var seasonNumber = Number(episode.season_number || episode.season || 0);

            if (seasonNumber && isReleased(episode) && seasonNumber > season) season = seasonNumber;
        });

        return season;
    }

    function hasPendingInReleasedSeason(episodes) {
        var season = latestReleasedSeason(episodes);

        if (!season) return hasPendingKnownEpisodes(episodes);

        return (episodes || []).some(function (episode) {
            var seasonNumber = Number(episode.season_number || episode.season || 0);
            return seasonNumber === season && (!episode.air_date || !isReleased(episode));
        });
    }

    function indexEpisodeHashes(card, episodes) {
        var key = cardKey(card);

        (episodes || []).forEach(function (episode) {
            var epHash = episodeHash(card, episode);
            if (epHash || epHash === 0) runtime.hashToKey[String(epHash)] = key;
        });
    }

    function analyzeShow(card) {
        var baseCard = normalizeCard(card);

        return loadDetails(baseCard).then(function (details) {
            var mergedCard = mergeDetails(baseCard, details);

            return loadEpisodes(mergedCard, details).then(function (episodes) {
                var released = releasedEpisodes(episodes);
                var unseen = [];

                released.forEach(function (episode) {
                    if (!isEpisodeViewed(mergedCard, episode)) unseen.push(episode);
                });

                indexEpisodeHashes(mergedCard, episodes);

                return {
                    key: cardKey(mergedCard),
                    card: mergedCard,
                    count: unseen.length,
                    released: released.length,
                    total: episodes.length,
                    first: unseen[0] || null,
                    next: nextFutureEpisode(episodes),
                    pending: hasPendingKnownEpisodes(episodes),
                    pendingInReleasedSeason: hasPendingInReleasedSeason(episodes),
                    ended: isEndedShow(mergedCard, details),
                    complete: true
                };
            });
        });
    }

    function targetMarkForAnalysis(analysis) {
        if (!analysis) return '';
        if (analysis.count > 0) return 'look';
        if (analysis.ended) return 'viewed';
        return analysis.pendingInReleasedSeason ? '' : 'continued';
    }

    function shouldApplyAnalysis(card, analysis, reason) {
        var status = favoriteStatus(card);
        var mark = currentMark(status);

        if (!analysis || analysis.complete === false) return false;
        if (status.viewed) return false;
        if (!targetMarkForAnalysis(analysis)) return false;

        if (reason === 'history') return true;

        if (analysis.count > 0) {
            if (reason === 'timeline') return true;
            return mark === 'look' || mark === 'continued';
        }

        return mark === 'look';
    }

    function applyAnalysisStatus(card, analysis, reason) {
        var target = targetMarkForAnalysis(analysis);
        analysis.targetMark = target;

        if (shouldApplyAnalysis(card, analysis, reason)) setFavoriteMark(analysis.card || card, target);
    }

    function handleAnalyzeFailure(card, error) {
        var key = cardKey(card);
        var previous = cacheItem(key);

        if (previous && previous.count >= 0) {
            previous.error = error && error.message ? error.message : String(error || 'Unknown error');
            previous.updatedAt = Date.now();
            cacheSave();
            sendStateChanged('update', card, key);
            return;
        }

        saveAnalysis({
            key: key,
            card: normalizeCard(card),
            count: 0,
            released: 0,
            total: 0,
            first: null,
            next: null,
            pending: false,
            pendingInReleasedSeason: false,
            ended: false,
            complete: false,
            error: error && error.message ? error.message : String(error || 'Unknown error')
        });
    }

    function analyzeAndApply(card, reason) {
        return analyzeShow(card).then(function (analysis) {
            applyAnalysisStatus(card, analysis, reason);
            saveAnalysis(analysis);
            return analysis;
        }, function (error) {
            log('analyze failed', titleOf(card), error);
            handleAnalyzeFailure(card, error);
            throw error;
        });
    }

    function enqueue(card, reason) {
        if (runtime.destroyed || !isTvCandidate(card)) return false;

        var normalized = normalizeCard(card);
        var key = cardKey(normalized);

        if (!key) return false;

        runtime.queued[key] = {
            card: normalized,
            reason: reason || 'scan'
        };

        if (runtime.queue.indexOf(key) === -1) runtime.queue.push(key);

        scheduleQueue();
        return true;
    }

    function scheduleQueue() {
        if (runtime.queueTimer || runtime.running || runtime.destroyed) return;

        runtime.queueTimer = setTimeout(function () {
            runtime.queueTimer = 0;
            processQueue();
        }, CONFIG.queue_delay_ms);
    }

    function processQueue() {
        if (runtime.destroyed || runtime.running) return;

        var key = runtime.queue.shift();
        if (!key) return;

        var item = runtime.queued[key];
        delete runtime.queued[key];

        if (!item || !item.card) {
            scheduleQueue();
            return;
        }

        runtime.running = true;

        analyzeAndApply(item.card, item.reason).then(function () {
            runtime.running = false;
            scheduleQueue();
        }, function () {
            runtime.running = false;
            scheduleQueue();
        });
    }

    function favoriteGet(type) {
        try {
            if (window.Lampa && Lampa.Favorite && Lampa.Favorite.get) return Lampa.Favorite.get({ type: type }) || [];
        } catch (e) {}

        return [];
    }

    function collectCards() {
        var result = [];
        var seen = {};

        SCAN_CATEGORIES.forEach(function (category) {
            favoriteGet(category).forEach(function (card) {
                var key = cardKey(card);
                if (!key || seen[key] || !isTvCandidate(card)) return;

                seen[key] = true;
                result.push({ card: card, category: category });
            });
        });

        return result;
    }

    function scanFavorites() {
        collectCards().forEach(function (item) {
            if (item.category !== 'history' || !favoriteStatus(item.card).viewed) {
                enqueue(item.card, item.category === 'history' ? 'history' : 'scan');
            }
        });
    }

    function findKnownCardByKey(key) {
        var cached = cacheItem(key);
        if (cached && cached.card) return cached.card;

        var found = null;

        collectCards().some(function (item) {
            if (cardKey(item.card) === key) {
                found = item.card;
                return true;
            }

            return false;
        });

        return found;
    }

    function enqueueByTimelineHash(timelineHash) {
        var hashKey = String(timelineHash);
        var key = runtime.hashToKey[hashKey];
        var card = key ? findKnownCardByKey(key) : null;

        if (!card && runtime.lastFullCard && Date.now() - runtime.lastFullAt < CONFIG.current_full_ttl_ms) {
            card = runtime.lastFullCard;
        }

        if (card) enqueue(card, 'timeline');
    }

    function handleFavoriteEvent(e) {
        if (!e || e.target !== 'favorite' || e.reason !== 'update' || !e.card) return;

        if (!isTvCandidate(e.card)) return;

        if (e.type === 'history' && (e.method === 'add' || e.method === 'added')) {
            if (favoriteStatus(e.card).viewed) return;

            enqueue(e.card, 'history');
            return;
        }

        if (e.type === 'look' || e.type === 'continued' || e.type === 'viewed') enqueue(e.card, 'favorite');
    }

    function handleStateChanged(e) {
        if (!e) return;

        handleFavoriteEvent(e);

        if (e.target === 'timeline' && e.reason === 'update' && e.data && typeof e.data.hash !== 'undefined') {
            enqueueByTimelineHash(e.data.hash);
        }

        if (e.target === 'timetable' && e.id) {
            var key = 'tmdb:' + String(e.id);
            var card = findKnownCardByKey(key);
            if (card) enqueue(card, 'timetable');
        }
    }

    function handleFullEvent(e) {
        var card = e && e.data && e.data.movie ? e.data.movie : e && e.object && e.object.card ? e.object.card : null;

        if (!card || !isTvCandidate(card)) return;

        runtime.lastFullCard = normalizeCard(card);
        runtime.lastFullAt = Date.now();
    }

    function sendStateChanged(reason, card, key) {
        try {
            if (window.Lampa && Lampa.Listener && Lampa.Listener.send) {
                Lampa.Listener.send('state:changed', {
                    target: 'smart_bookmarks',
                    reason: reason || 'update',
                    card: card,
                    key: key || cardKey(card)
                });
            }
        } catch (e) {}
    }

    function start() {
        if (runtime.started || runtime.destroyed) return;

        if (!window.Lampa || !Lampa.Listener || !Lampa.Favorite || !Lampa.Api || !Lampa.Api.sources || !Lampa.Api.sources.tmdb) {
            runtime.startupTimer = setTimeout(start, 1000);
            return;
        }

        runtime.started = true;
        cacheLoad();
        registerPluginMetadata();

        runtime.stateListener = handleStateChanged;
        runtime.fullListener = handleFullEvent;

        Lampa.Listener.follow('state:changed', runtime.stateListener);
        Lampa.Listener.follow('full', runtime.fullListener);

        runtime.startupTimer = setTimeout(function () {
            runtime.startupTimer = 0;
            scanFavorites();
        }, CONFIG.startup_delay_ms);

        log('started');
    }

    runtime.destroy = function () {
        runtime.destroyed = true;

        clearTimeout(runtime.startupTimer);
        clearTimeout(runtime.queueTimer);

        try {
            if (window.Lampa && Lampa.Listener && runtime.stateListener) {
                Lampa.Listener.remove('state:changed', runtime.stateListener);
            }

            if (window.Lampa && Lampa.Listener && runtime.fullListener) {
                Lampa.Listener.remove('full', runtime.fullListener);
            }

            if (window.Lampa && Lampa.Listener && runtime.appListener) {
                Lampa.Listener.remove('app', runtime.appListener);
            }
        } catch (e) {}
    };

    if (window.appready) start();
    else {
        runtime.appListener = function (e) {
            if (e && e.type === 'ready') start();
        };

        if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', runtime.appListener);
        else setTimeout(start, 1000);
    }
})();
