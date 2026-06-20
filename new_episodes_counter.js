(function () {
    'use strict';

    /**
     * New Episodes Counter показывает, сколько вышедших серий еще не просмотрено.
     *
     * Что делает плагин:
     * - добавляет небольшой счетчик серий на карточки сериалов только если
     *   сериал находится в закладке "Я смотрю";
     * - пересчитывает счетчики в фоне по сезонам TMDB и отметкам Lampa Timeline;
     * - обновляет видимые карточки после изменений timeline/favorite/timetable
     *   без перезагрузки всей страницы.
     *
     * Плагин использует только штатные API Lampa: Favorite, Timeline, TimeTable
     * и TMDB.
     */

    var PLUGIN_VERSION = '1.0.0';
    var PLUGIN_NAME = 'New Episodes Counter';
    var PLUGIN_AUTHOR = 'dan7829';
    var PLUGIN_DESCRIPTION = 'Показывает на карточках сериалов количество вышедших непросмотренных серий.';
    var PLUGIN_FILE_NAME = 'new_episodes_counter.js';
    var PLUGIN_ID = 'new_episodes_counter_' + safeVersionSuffix(PLUGIN_VERSION);
    var RUNTIME_KEY = 'new_episodes_counter_runtime';
    var CACHE_KEY = 'new_episodes_counter_cache';
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
        cache_ttl_hours: 6,
        queue_delay_ms: 250,
        hover_refresh_delay_ms: 500,
        watched_threshold_percent: 90,
        debug: false
    };

    var cacheState = null;

    var runtime = {
        destroyed: false,
        started: false,
        stateListener: null,
        appListener: null,
        renderTimer: 0,
        queueTimer: 0,
        running: false,
        queue: [],
        queued: {},
        cardByKey: {},
        hashToKey: {},
        instances: [],
        patched: [],
        destroy: null
    };

    window[RUNTIME_KEY] = runtime;

    function safeVersionSuffix(version) {
        return String(version || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '0';
    }

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[NewEpisodesCounter v' + PLUGIN_VERSION + ']');
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
            var plugins = storageGet('plugins', []);
            var currentUrl = currentPluginUrl();
            var changed = false;

            if (!Array.isArray(plugins)) return;

            plugins = plugins.map(function (plugin) {
                var item = typeof plugin === 'string' ? { url: plugin, status: 1 } : clone(plugin);

                if (!item.url || !samePluginUrl(item.url, currentUrl)) return plugin;

                if (item.name !== PLUGIN_NAME) {
                    item.name = PLUGIN_NAME;
                    changed = true;
                }

                if (item.author !== PLUGIN_AUTHOR) {
                    item.author = PLUGIN_AUTHOR;
                    changed = true;
                }

                if (item.descr !== PLUGIN_DESCRIPTION) {
                    item.descr = PLUGIN_DESCRIPTION;
                    changed = true;
                }

                if (item.description !== PLUGIN_DESCRIPTION) {
                    item.description = PLUGIN_DESCRIPTION;
                    changed = true;
                }

                if (item.version !== PLUGIN_VERSION) {
                    item.version = PLUGIN_VERSION;
                    changed = true;
                }

                return item;
            });

            if (changed) storageSet('plugins', plugins);
        } catch (e) {}
    }

    function freshCache() {
        return {
            version: CACHE_VERSION,
            pluginVersion: PLUGIN_VERSION,
            updatedAt: 0,
            items: {},
            data: {}
        };
    }

    function validCache(cache) {
        return !!(
            cache &&
            cache.version === CACHE_VERSION &&
            cache.pluginVersion === PLUGIN_VERSION &&
            cache.items &&
            typeof cache.items === 'object' &&
            !Array.isArray(cache.items) &&
            cache.data &&
            typeof cache.data === 'object' &&
            !Array.isArray(cache.data)
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

        hydrateRuntimeFromCache(cacheState);

        return cacheState;
    }

    function hydrateRuntimeFromCache(cache) {
        if (!cache || !cache.items) return;

        Object.keys(cache.items).forEach(function (key) {
            var item = cache.items[key];

            if (!item) return;
            if (item.card) runtime.cardByKey[key] = item.card;

            (item.hashes || []).forEach(function (hashValue) {
                runtime.hashToKey[String(hashValue)] = key;
            });
        });
    }

    function cacheSave() {
        if (!cacheState) return;
        cacheState.pluginVersion = PLUGIN_VERSION;
        cacheState.updatedAt = Date.now();
        storageSet(CACHE_KEY, cacheState);
    }

    function cacheTtlMs() {
        return Number(CONFIG.cache_ttl_hours || 6) * 60 * 60 * 1000;
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

        Object.keys(cache.data).forEach(function (key) {
            var item = cache.data[key];

            if (!item || !item.updatedAt || now - item.updatedAt > ttl * 4) {
                delete cache.data[key];
                changed = true;
            }
        });

        if (changed) cacheSave();
    }

    function dataCacheGet(key) {
        var item = cacheLoad().data[key];
        if (!item || !item.updatedAt || Date.now() - item.updatedAt > cacheTtlMs()) return null;
        return item.data || null;
    }

    function dataCacheSet(key, data) {
        var cache = cacheLoad();

        cache.data[key] = {
            key: key,
            data: data,
            updatedAt: Date.now()
        };

        cacheSave();
    }

    function cacheItem(card) {
        var key = typeof card === 'string' ? card : cardKey(card);
        if (!key) return null;
        return cacheLoad().items[key] || null;
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
            hashes: analysis.hashes || [],
            complete: analysis.complete !== false,
            updatedAt: Date.now(),
            error: analysis.error || ''
        };

        runtime.cardByKey[analysis.key] = analysis.card;
        (analysis.hashes || []).forEach(function (hashValue) {
            runtime.hashToKey[String(hashValue)] = analysis.key;
        });

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
            'original_language',
            'status'
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

    function favoriteStatus(card) {
        try {
            if (window.Lampa && Lampa.Favorite && Lampa.Favorite.check) return Lampa.Favorite.check(card) || {};
        } catch (e) {}

        return {};
    }

    function isLookCard(card) {
        return Boolean(favoriteStatus(card).look);
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

    function sortEpisodes(episodes) {
        return (episodes || []).sort(function (a, b) {
            if (a.season !== b.season) return a.season - b.season;
            if (a.episode !== b.episode) return a.episode - b.episode;
            return String(a.air_date || '').localeCompare(String(b.air_date || ''));
        });
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

    function analyzeShow(card) {
        var baseCard = normalizeCard(card);

        return loadDetails(baseCard).then(function (details) {
            var mergedCard = mergeDetails(baseCard, details);

            return loadEpisodes(mergedCard, details).then(function (episodes) {
                var released = sortEpisodes(episodes.filter(isReleased));
                var unseen = [];
                var hashes = [];

                episodes.forEach(function (episode) {
                    var epHash = episodeHash(mergedCard, episode);
                    if (epHash || epHash === 0) hashes.push(String(epHash));
                });

                released.forEach(function (episode) {
                    if (!isEpisodeViewed(mergedCard, episode)) unseen.push(episode);
                });

                return {
                    key: cardKey(mergedCard),
                    card: mergedCard,
                    count: unseen.length,
                    released: released.length,
                    total: episodes.length,
                    first: unseen[0] || null,
                    hashes: hashes,
                    complete: true
                };
            });
        });
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
            hashes: [],
            complete: false,
            error: error && error.message ? error.message : String(error || 'Unknown error')
        });
    }

    function isCounterStale(card) {
        var item = cacheItem(card);
        if (!item || item.complete === false) return true;
        return Date.now() - item.updatedAt > cacheTtlMs();
    }

    function enqueue(card, reason, force) {
        if (runtime.destroyed || !isTvCandidate(card) || !isLookCard(card)) return false;
        if (!force && !isCounterStale(card)) return false;

        var normalized = normalizeCard(card);
        var key = cardKey(normalized);

        if (!key) return false;

        runtime.cardByKey[key] = normalized;
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

        analyzeShow(item.card).then(function (analysis) {
            debug('analyzed', titleOf(item.card), analysis.count, item.reason);
            saveAnalysis(analysis);
            runtime.running = false;
            scheduleQueue();
        }, function (error) {
            log('analyze failed', titleOf(item.card), error);
            handleAnalyzeFailure(item.card, error);
            runtime.running = false;
            scheduleQueue();
        });
    }

    function counterValue(card) {
        if (!isTvCandidate(card)) return 0;
        if (!isLookCard(card)) return 0;

        var item = cacheItem(card);
        return item && item.complete !== false ? Number(item.count || 0) : 0;
    }

    function getHtml(instance) {
        if (!instance) return null;
        if (instance.html) return instance.html.jquery ? instance.html[0] : instance.html;
        if (instance.card) return instance.card.jquery ? instance.card[0] : instance.card;
        return null;
    }

    function hasClass(element, className) {
        return String(element && element.className || '').split(/\s+/).indexOf(className) !== -1;
    }

    function removeNode(element) {
        if (!element) return;

        if (element.parentNode && element.parentNode.removeChild) {
            element.parentNode.removeChild(element);
        }
        else if (element.remove) {
            element.remove();
        }
    }

    function removeStandaloneBadges(html) {
        if (!html || !html.querySelector) return;

        if (html.querySelectorAll) {
            Array.prototype.slice.call(html.querySelectorAll('.new-episodes-count')).forEach(function (badge) {
                if (!hasClass(badge, 'card__type')) removeNode(badge);
            });
        }
        else {
            var badge = html.querySelector('.new-episodes-count');
            if (badge && !hasClass(badge, 'card__type')) removeNode(badge);
        }
    }

    function removeBadge(instance) {
        var html = getHtml(instance);
        if (!html || !html.querySelector) return;

        removeStandaloneBadges(html);
        restoreLegacyTypeBadge(html);
    }

    function restoreLegacyTypeBadge(html) {
        var type = html && html.querySelector ? html.querySelector('.card__type') : null;

        if (!type) return;

        var originalText = type.dataset && type.dataset.newEpisodesOriginalText
            ? type.dataset.newEpisodesOriginalText
            : type.__newEpisodesOriginalText;

        if (originalText) {
            type.textContent = originalText;
            type.__newEpisodesOriginalText = '';

            if (typeof type.dataset !== 'undefined') delete type.dataset.newEpisodesOriginalText;
        }

        if (type.classList && type.classList.remove) {
            type.classList.remove('new-episodes-count');
        }
    }

    function rememberTypeText(type) {
        var current = type.textContent || 'TV';

        if (type.dataset) {
            if (!type.dataset.newEpisodesOriginalText) type.dataset.newEpisodesOriginalText = current;
            return type.dataset.newEpisodesOriginalText;
        }

        if (!type.__newEpisodesOriginalText) type.__newEpisodesOriginalText = current;
        return type.__newEpisodesOriginalText;
    }

    function addTypeClass(type) {
        if (type.classList && type.classList.add) {
            type.classList.add('new-episodes-count');
        }
        else if (!hasClass(type, 'new-episodes-count')) {
            type.className = String(type.className || '') + ' new-episodes-count';
        }
    }

    function renderBadge(instance) {
        if (!instance || !instance.data) return;

        var html = getHtml(instance);
        if (!html || !html.querySelector) return;

        removeStandaloneBadges(html);
        restoreLegacyTypeBadge(html);

        if (isTvCandidate(instance.data)) enqueue(instance.data, 'render', false);

        var count = counterValue(instance.data);
        var type = html.querySelector('.card__type');

        if (!count) {
            removeBadge(instance);
            return;
        }

        if (!type) return;

        rememberTypeText(type);
        addTypeClass(type);

        type.textContent = String(count);
    }

    function attachCardEvents(instance) {
        var html = getHtml(instance);

        if (!html || html.__newEpisodesCounterEvents || !instance.data) return;

        var timer = 0;
        var refresh = function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                enqueue(instance.data, 'focus', true);
            }, CONFIG.hover_refresh_delay_ms);
        };

        html.__newEpisodesCounterEvents = true;
        html.__newEpisodesCounterRefresh = refresh;

        try {
            if (html.addEventListener) {
                html.addEventListener('hover:focus', refresh);
                html.addEventListener('hover:touch', refresh);
                html.addEventListener('hover:hover', refresh);
            }
        } catch (e) {}

        try {
            if (html.on) html.on('hover:focus hover:touch hover:hover', refresh);
        } catch (e2) {}
    }

    function remember(instance) {
        if (!instance || runtime.instances.indexOf(instance) !== -1) return;

        runtime.instances.push(instance);

        if (instance.data) {
            var key = cardKey(instance.data);
            if (key) runtime.cardByKey[key] = instance.data;
        }
    }

    function forget(instance) {
        runtime.instances = runtime.instances.filter(function (item) {
            return item !== instance;
        });
    }

    function renderAll() {
        if (runtime.destroyed) return;

        runtime.instances = runtime.instances.filter(function (instance) {
            return !!getHtml(instance);
        });

        runtime.instances.forEach(renderBadge);
    }

    function scheduleRenderAll() {
        clearTimeout(runtime.renderTimer);
        runtime.renderTimer = setTimeout(function () {
            runtime.renderTimer = 0;
            renderAll();
        }, 100);
    }

    function visibleLookCards() {
        var cards = [];
        var seen = {};

        runtime.instances.forEach(function (instance) {
            var card = instance && instance.data;
            var key = cardKey(card);

            if (!key || seen[key] || !isTvCandidate(card) || !isLookCard(card)) return;

            seen[key] = true;
            cards.push(card);
        });

        return cards;
    }

    function cardByKey(key) {
        if (runtime.cardByKey[key]) return runtime.cardByKey[key];

        var item = cacheItem(key);
        if (item && item.card) return item.card;

        return null;
    }

    function enqueueByTimelineHash(timelineHash) {
        var key = runtime.hashToKey[String(timelineHash)];

        if (key) {
            var card = cardByKey(key);
            if (card) enqueue(card, 'timeline', true);
            return;
        }

        visibleLookCards().forEach(function (card) {
            enqueue(card, 'timeline-visible', true);
        });
    }

    function patchPrototype(Constructor, createName, updateName, destroyName) {
        if (!Constructor || !Constructor.prototype || Constructor.prototype.__newEpisodesCounterPatched) return false;

        var proto = Constructor.prototype;
        var originalCreate = proto[createName];
        var originalUpdate = updateName ? proto[updateName] : null;
        var originalDestroy = destroyName ? proto[destroyName] : null;

        if (typeof originalCreate !== 'function') return false;

        proto.__newEpisodesCounterPatched = true;

        proto[createName] = function () {
            var result = originalCreate.apply(this, arguments);
            remember(this);
            attachCardEvents(this);
            renderBadge(this);
            return result;
        };

        if (updateName && typeof originalUpdate === 'function') {
            proto[updateName] = function () {
                var result = originalUpdate.apply(this, arguments);
                attachCardEvents(this);
                renderBadge(this);
                return result;
            };
        }

        if (destroyName && typeof originalDestroy === 'function') {
            proto[destroyName] = function () {
                removeBadge(this);
                forget(this);
                return originalDestroy.apply(this, arguments);
            };
        }

        runtime.patched.push({
            proto: proto,
            createName: createName,
            updateName: updateName,
            destroyName: destroyName,
            originalCreate: originalCreate,
            originalUpdate: originalUpdate,
            originalDestroy: originalDestroy
        });

        return true;
    }

    function restorePatches() {
        runtime.patched.forEach(function (patch) {
            patch.proto[patch.createName] = patch.originalCreate;

            if (patch.updateName && patch.originalUpdate) patch.proto[patch.updateName] = patch.originalUpdate;
            if (patch.destroyName && patch.originalDestroy) patch.proto[patch.destroyName] = patch.originalDestroy;

            delete patch.proto.__newEpisodesCounterPatched;
        });

        runtime.patched = [];
    }

    function injectStyles() {
        if (document.getElementById('new-episodes-counter-styles')) return;

        var style = document.createElement('style');
        style.id = 'new-episodes-counter-styles';
        style.textContent = [
            '.card__type.new-episodes-count{',
            'min-width:2em;',
            'text-align:center;',
            'box-sizing:border-box;',
            'font-variant-numeric:tabular-nums;',
            '}'
        ].join('');

        document.head.appendChild(style);
    }

    function patchCards() {
        var patched = false;

        try {
            if (window.Lampa && Lampa.Maker && Lampa.Maker.get) {
                patched = patchPrototype(Lampa.Maker.get('Card'), 'create', 'update', 'destroy') || patched;
            }
        } catch (e) {}

        try {
            if (window.Lampa && Lampa.Card) {
                patched = patchPrototype(Lampa.Card, 'build', null, null) || patched;
            }
        } catch (e2) {}

        return patched;
    }

    function handleFavoriteEvent(e) {
        if (!e || e.target !== 'favorite' || !e.card || !isTvCandidate(e.card)) return;

        if (e.type === 'look') enqueue(e.card, 'favorite-look', true);

        if (e.type === 'look' || e.type === 'viewed' || e.type === 'continued' || e.type === 'thrown') {
            scheduleRenderAll();
        }
    }

    function handleStateChanged(e) {
        if (!e) return;

        handleFavoriteEvent(e);

        if (e.target === 'timeline' && e.reason === 'update' && e.data && typeof e.data.hash !== 'undefined') {
            enqueueByTimelineHash(e.data.hash);
            scheduleRenderAll();
        }

        if (e.target === 'timetable' && e.id) {
            var card = cardByKey('tmdb:' + String(e.id));
            if (card) enqueue(card, 'timetable', true);
        }

        if (e.target === 'new_episodes_counter') scheduleRenderAll();
    }

    function sendStateChanged(reason, card, key) {
        try {
            if (window.Lampa && Lampa.Listener && Lampa.Listener.send) {
                Lampa.Listener.send('state:changed', {
                    target: 'new_episodes_counter',
                    reason: reason || 'update',
                    card: card,
                    key: key || cardKey(card)
                });
            }
        } catch (e) {}
    }

    function start() {
        if (runtime.started || runtime.destroyed) return;

        if (
            !window.Lampa ||
            !Lampa.Listener ||
            !Lampa.Favorite ||
            !Lampa.Api ||
            !Lampa.Api.sources ||
            !Lampa.Api.sources.tmdb ||
            !Lampa.Maker ||
            !Lampa.Maker.get
        ) {
            setTimeout(start, 1000);
            return;
        }

        runtime.started = true;

        cacheLoad();
        registerPluginMetadata();
        injectStyles();
        patchCards();

        runtime.stateListener = handleStateChanged;
        Lampa.Listener.follow('state:changed', runtime.stateListener);

        log('started');
    }

    runtime.destroy = function () {
        runtime.destroyed = true;

        clearTimeout(runtime.renderTimer);
        clearTimeout(runtime.queueTimer);
        restorePatches();

        try {
            if (window.Lampa && Lampa.Listener && runtime.stateListener) {
                Lampa.Listener.remove('state:changed', runtime.stateListener);
            }

            if (window.Lampa && Lampa.Listener && runtime.appListener) {
                Lampa.Listener.remove('app', runtime.appListener);
            }
        } catch (e) {}

        var style = document.getElementById('new-episodes-counter-styles');
        if (style) style.remove();

        runtime.instances.forEach(removeBadge);
        runtime.instances = [];
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
