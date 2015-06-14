// ==UserScript==
// @name         AutoUpgrade
// @namespace    https://github.com/DannyDaemonic/SteamMonsterAutoUpgradeManager
// @version      0.2
// @description  An automatic upgrade manager for the 2015 Summer Steam Monster Minigame
// @match *://steamcommunity.com/minigame/towerattack*
// @match *://steamcommunity.com//minigame/towerattack*
// @grant        none
// ==/UserScript==

var upgradeManagerPrefilter;
var upgradeManager;

function startUpgradeManager() {
  /************
   * SETTINGS *
   ************/
  // On each level, we check for the lane that has the highest enemy DPS.
  // Based on that DPS, if we would not be able to survive more than
  // `survivalTime` seconds, we should buy some armor.
  var survivalTime = 30;

  // To estimate the overall boost in damage from upgrading an element,
  // we sort the elements from highest level to lowest, then multiply
  // each one's level by the number in the corresponding spot to get a
  // weighted average of their effects on your overall damage per click.
  // If you don't prioritize lanes that you're strongest against, this
  // will be [0.25, 0.25, 0.25, 0.25], giving each element an equal
  // scaling. However, this defaults to [0.4, 0.3, 0.2, 0.1] under the
  // assumption that you will spend much more time in lanes with your
  // strongest elements.
  var elementalCoefficients = [0.4, 0.3, 0.2, 0.1];

  // How many elements do you want to upgrade? If we decide to upgrade an
  // element, we'll try to always keep this many as close in levels as we
  // can, and ignore the rest.
  var elementalSpecializations = 1;

  // To include passive DPS upgrades (Auto-fire, etc.) we have to scale
  // down their DPS boosts for an accurate comparison to clicking. This
  // is approximately how many clicks per second we should assume you are
  // consistently doing. If you have an autoclicker, this is easy to set.
  var clickFrequency = 20; // assume maximum of 20

  // Should we buy abilities? Note that Medics will always be bought since
  // it is considered a necessary upgrade.
  var buyAbilities = false;

  /***********
   * GLOBALS *
   ***********/
  var scene = g_Minigame.CurrentScene();
  var waitingForUpdate = false;

  var next = {
    id: -1,
    cost: 0
  };

  var necessary = [
    { id: 0, level: 1 }, // Light Armor
    { id: 11, level: 1 }, // Medics
    { id: 2, level: 10 }, // Armor Piercing Round
    { id: 1, level: 10 }, // Auto-fire Cannon
  ];

  var gAbilities = [
    11, // Medics
    13, // Good Luck Charms
    16, // Tactical Nuke
    18, // Napalm
    17, // Cluster Bomb
    14, // Metal Detector
    15, // Decrease Cooldowns
    12, // Morale Booster
  ];

  var gHealthUpgrades = [
    0,  // Light Armor
    8,  // Heavy Armor
    20, // Energy Shields
    23, // Personal Training
  ];

  var gAutoUpgrades = [1, 9, 21, 24]; // nobody cares

  var gLuckyShot = 7;

  var gDamageUpgrades = [
    2,  // Armor Piercing Round
    10, // Explosive Rouds
    22, // Railgun
    25, // New Mouse Button
  ];

  var gElementalUpgrades = [3, 4, 5, 6]; // Fire, Water, Earth, Air

  /***********
   * HELPERS *
   ***********/
  var getUpgrade = function(id) {
    var result = null;
    if (scene.m_rgPlayerUpgrades) {
      scene.m_rgPlayerUpgrades.some(function(upgrade) {
        if (upgrade.upgrade == id) {
          result = upgrade;
          return true;
        }
      });
    }
    return result;
  };

  var getElementals = (function() {
    var cache = false;
    return function(refresh) {
      if (!cache || refresh) {
        cache = gElementalUpgrades
          .map(function(id) { return { id: id, level: getUpgrade(id).level }; })
          .sort(function(a, b) { return b.level - a.level; });
      }
      return cache;
    };
  })();

  var getElementalCoefficient = function(elementals) {
    elementals = elementals || getElementals();
    return scene.m_rgTuningData.upgrades[4].multiplier *
      elementals.reduce(function(sum, elemental, i) {
        return sum + elemental.level * elementalCoefficients[i];
      }, 0);
  };

  var canUpgrade = function(id) {
    // do we even have the upgrade?
    if (!scene.bHaveUpgrade(id)) return false;

    // does it have a required upgrade?
    var data = scene.m_rgTuningData.upgrades[id];
    var required = data.required_upgrade;
    if (required !== undefined) {
      // is it at the required level to unlock?
      var level = data.required_upgrade_level || 1;
      return (level <= scene.GetUpgradeLevel(required));
    }

    // otherwise, we're good to go!
    return true;
  };

  var calculateUpgradeTree = function(id, level) {
    var base_dpc = scene.m_rgTuningData.player.damage_per_click;
    var data = scene.m_rgTuningData.upgrades[id];
    var boost = 0;
    var cost = 0;
    var parent;

    var cur_level = getUpgrade(id).level;
    if (level === undefined) level = cur_level + 1;

    // for each missing level, add boost and cost
    for (var level_diff = level - getUpgrade(id).level; level_diff > 0; level_diff--) {
      boost += base_dpc * data.multiplier;
      cost += data.cost * Math.pow(data.cost_exponential_base, level - level_diff);
    }

    // recurse for required upgrades
    var required = data.required_upgrade;
    if (required !== undefined) {
      var parents = calculateUpgradeTree(required, data.required_upgrade_level || 1);
      if (parents.cost > 0) {
        boost += parents.boost;
        cost += parents.cost;
        parent = parents.required || required;
      }
    }

    return { boost: boost, cost: cost, required: parent };
  };

  var necessaryUpgrade = function() {
    var best = { id: -1, cost: 0 };
    var wanted, id, current;
    while (necessary.length > 0) {
      wanted = necessary[0];
      id = wanted.id;
      current = getUpgrade(id);
      if (current.level < wanted.level) {
        var data = scene.m_rgTuningData.upgrades[id];
        best = { id: id, cost: data.cost * Math.pow(data.cost_exponential_base, current.level) };
        break;
      }
      necessary.shift();
    }
    return best;
  };

  var nextAbilityUpgrade = function() {
    var best = { id: -1, cost: 0 };
    if (buyAbilities) {
      gAbilities.some(function(id) {
        if (canUpgrade(id) && getUpgrade(id).level < 1) {
          best = { id: id, cost: scene.m_rgTuningData.upgrades[id].cost };
          return true;
        }
      });
    }
    return best;
  };

  var bestHealthUpgrade = function() {
    var best = { id: -1, cost: 0, hpg: 0 };
    gHealthUpgrades.forEach(function(id) {
      if (!canUpgrade(id)) return;
      var data = scene.m_rgTuningData.upgrades[id];
      var upgrade = getUpgrade(id);
      var cost = data.cost * Math.pow(data.cost_exponential_base, upgrade.level);
      var hpg = scene.m_rgTuningData.player.hp * data.multiplier / cost;
      if (hpg >= best.hpg) {
        best = { id: id, cost: cost, hpg: hpg };
      }
    });
    return best;
  };

  var bestDamageUpgrade = function() {
    var best = { id: -1, cost: 0, dpg: 0 };
    var data, cost, dpg, boost;

    var dpc = scene.m_rgPlayerTechTree.damage_per_click;
    var base_dpc = scene.m_rgTuningData.player.damage_per_click;
    var critmult = scene.m_rgPlayerTechTree.damage_multiplier_crit;
    var critrate = scene.m_rgPlayerTechTree.crit_percentage - scene.m_rgTuningData.player.crit_percentage;
    var elementals = getElementals();
    var elementalCoefficient = getElementalCoefficient(elementals);

    // lazily check auto damage upgrades; assume we don't care about these
    gAutoUpgrades.forEach(function(id) {
      if (!canUpgrade(id)) return;
      data = scene.m_rgTuningData.upgrades[id];
      cost = data.cost * Math.pow(data.cost_exponential_base, getUpgrade(id).level);
      dpg = (scene.m_rgPlayerTechTree.base_dps / clickFrequency) * data.multiplier / cost;
      if (dpg >= best.dpg) {
        best = { id: id, cost: cost, dpg: dpg };
      }
    });

    // check Lucky Shot
    if (canUpgrade(gLuckyShot)) { // lazy check because prereq is necessary upgrade
      data = scene.m_rgTuningData.upgrades[gLuckyShot];
      boost = dpc * critrate * data.multiplier;
      cost = data.cost * Math.pow(data.cost_exponential_base, getUpgrade(gLuckyShot).level);
      dpg = boost / cost;
      if (dpg >= best.dpg) {
        best = { id: gLuckyShot, cost: cost, dpg: dpg };
      }
    }

    // check click damage upgrades
    gDamageUpgrades.forEach(function(id) {
      var result = calculateUpgradeTree(id);
      boost = result.boost * (critrate * critmult + (1 - critrate) * elementalCoefficient);
      cost = result.cost;
      dpg = boost / cost;
      if (dpg >= best.dpg) {
        if (result.required) {
          id = result.required;
          data = scene.m_rgTuningData.upgrades[id];
          cost = data.cost * Math.pow(data.cost_exponential_base, getUpgrade(id).level);
        }
        best = { id: id, cost: cost, dpg: dpg };
      }
    });

    // check elementals
    data = scene.m_rgTuningData.upgrades[4];
    var elementalLevels = elementals.reduce(function(sum, elemental) {
      return sum + elemental.level;
    }, 1);
    cost = data.cost * Math.pow(data.cost_exponential_base, elementalLevels);

    // - make new elementals array for testing
    var testElementals = elementals.map(function(elemental) { return { level: elemental.level }; });
    var upgradeLevel = testElementals[elementalSpecializations - 1].level;
    testElementals[elementalSpecializations - 1].level++;
    if (elementalSpecializations > 1) {
      // swap positions if upgraded elemental now has bigger level than (originally) next highest
      var prevElem = testElementals[elementalSpecializations - 2].level;
      if (prevElem <= upgradeLevel) {
        testElementals[elementalSpecializations - 2].level = upgradeLevel + 1;
        testElementals[elementalSpecializations - 1].level = prevElem;
      }
    }

    // - calculate stats
    boost = dpc * (1 - critrate) * (getElementalCoefficient(testElementals) - elementalCoefficient);
    dpg = boost / cost;
    if (dpg > best.dpg) { // give base damage boosters priority
      // find all elements at upgradeLevel and randomly pick one
      var match = elementals.filter(function(elemental) { return elemental.level == upgradeLevel; });
      match = match[Math.floor(Math.random() * match.length)].id;
      best = { id: match, cost: cost, dpg: dpg };
    }

    return best;
  };

  var timeToDie = (function() {
    var cache = false;
    return function(refresh) {
      if (cache === false || refresh) {
        var maxHp = scene.m_rgPlayerTechTree.max_hp;
        var enemyDps = scene.m_rgGameData.lanes.reduce(function(max, lane) {
          return Math.max(max, lane.enemies.reduce(function(sum, enemy) {
            return sum + enemy.dps;
          }, 0));
        }, 0);
        cache = maxHp / (enemyDps || scene.m_rgGameData.level * 4);
      }
      return cache;
    };
  })();

  var updateNext = function() {
    next = necessaryUpgrade();
    if (next.id === -1) {
      if (timeToDie() < survivalTime) {
        next = bestHealthUpgrade();
      } else {
        var damage = bestDamageUpgrade();
        var ability = nextAbilityUpgrade();
        next = (damage.cost < ability.cost || ability.id === -1) ? damage : ability;
      }
    }
    if (next.id !== -1) {
      console.log(
          '%cnext buy: %c%s %c(%s)', 'font-weight:bold', 'color:red',
          scene.m_rgTuningData.upgrades[next.id].name, 'color:red;font-style:italic',
        FormatNumberForDisplay(next.cost)
      );
    }
  };

  var hook = function(base, method, func) {
    var original = method + '_upgradeManager';
    if (!base.prototype[original]) base.prototype[original] = base.prototype[method];
    base.prototype[method] = function() {
      this[original].apply(this, arguments);
      func.apply(this, arguments);
    };
  };

  /********
   * MAIN *
   ********/
  hook(CSceneGame, 'TryUpgrade', function() {
    // if it's a valid try, we should reevaluate after the update
    if (this.m_bUpgradesBusy) next.id = -1;
  });
  
  hook(CSceneGame, 'ChangeLevel', function() {
    // recalculate enemy DPS to see if we can survive this level
    if (timeToDie(true) < survivalTime) updateNext();
  });

  upgradeManagerPrefilter = function(opts, origOpts, xhr) {
    if (opts.url.match(/ChooseUpgrade/)) {
      xhr
      .success(function() {
        // wait as short a delay as possible
        // then we re-run to figure out the next item to queue
        window.setTimeout(upgradeManager, 0);
       })
      .fail(function() {
        // we're desynced. wait til data refresh
        // m_bUpgradesBusy was not set to false
        scene.m_bNeedTechTree = true;
        waitingForUpdate = true;
      });
    } else if (opts.url.match(/GetPlayerData/)) {
      if (waitingForUpdate) {
        xhr.success(function(result) {
          var message = g_Server.m_protobuf_GetPlayerDataResponse.decode(result).toRaw(true, true);
          if (message.tech_tree) {
            // done waiting! no longer busy
            waitingForUpdate = false;
            scene.m_bUpgradesBusy = false;
          }
        });
      }
    }
  };

  return function() {
    scene = g_Minigame.CurrentScene();
    
    // tried to buy upgrade and waiting for reply; don't do anything
    if (scene.m_bUpgradesBusy) return;
    
    // no item queued; refresh stats and queue next item
    if (next.id === -1) {
      getElementals(true);
      timeToDie(true);
      updateNext();
    }
    
    // item queued; buy if we can afford it
    if (next.id !== -1) {
      if (next.cost <= scene.m_rgPlayerData.gold) {
        $J('.link').each(function() {
          if ($J(this).data('type') === next.id) {
            scene.TryUpgrade(this);
            return false;
          }
        });
      }
    }
  };
}

function gameRunning() {
    return g_Minigame && g_Minigame.CurrentScene() && g_Minigame.CurrentScene().m_bRunning;
}

function tryStart() {
    if (!gameRunning()) {
        setTimeout(tryStart, 1000);
    } else {
        if (!upgradeManagerPrefilter) {
            // add prefilter on first run
            $J.ajaxPrefilter(function() {
                // this will be defined by the end of the script
                upgradeManagerPrefilter.apply(this, arguments);
            });
        }
        upgradeManager = startUpgradeManager();
        if (upgradeManagerTimer) window.clearTimeout(upgradeManagerTimer);
        var upgradeManagerTimer = window.setInterval(upgradeManager, 5000);
    }
}

setTimeout(tryStart, 5000);
