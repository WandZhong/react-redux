var Mocha = require("mocha");
var chai = require("chai");
var dir = require("node-dir");
var path = require("path");
var fs = require("fs");
var temp = require("temp");

var Contracts = require("./contracts");

var Pudding = require("ether-pudding");
var PuddingLoader = require("ether-pudding/loader");
var loadconf = require("./loadconf");
var Promise = require("bluebird");

var ExtendableError = require("./errors/extendableerror");

chai.use(require("./assertions"));

var rpc = function(method, arg, cb) {
  var req = {
    jsonrpc: "2.0",
    method: method,
    id: new Date().getTime()
  };
  if (arguments.length == 3) {
    req.params = arg;
  } else {
    cb = arg;
  }
  web3.currentProvider.sendAsync(req, cb);
};

// Deploy all configured contracts to the chain without recompiling
var redeploy_contracts = function(config, recompile, done) {
  Contracts.deploy(config, recompile, function(err) {
    if (err != null) {
      // Format our error messages so they print better with mocha.
      if (err instanceof ExtendableError) {
        err.formatForMocha();
      }

      done(err);
      return;
    }

    Pudding.setWeb3(config.web3);
    PuddingLoader.load(config.environments.current.directory, Pudding, global, function(err, contract_names) {
      for (var name in config.contracts.classes) {
        var contract = global[name];
        var inst = contract.at(contract.address);
        Truffle.log_filters.push(inst.allEvents({fromBlock: 0, toBlock: 'latest'}));
      }
      done();
    });
  });
};

var Test = {
  setup(config, callback) {
    var BEFORE_TIMEOUT = 120000;
    var TEST_TIMEOUT = 300000;

    // `accounts` will be populated before each contract()
    // invocation and passed to it so tests don't have to call it themselves.
    var accounts = [];

    global.web3 = config.web3;

    // Make Promise global so tests have access to it.
    global.Promise = Promise;

    // Use custom assertions.
    global.assert = chai.assert;

    global.Truffle = {
      can_revert: false,

      log_filters: [],

      redeploy: function(recompile) {
        return new Promise(function(resolve, reject) {
          redeploy_contracts(config, recompile, function(err) {
            console.log(error)

            if (err != null) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      },

      handle_errs: (done) => { Promise.onPossiblyUnhandledRejection(done); },

      reset: function(cb) {
        rpc("evm_reset", cb);
      },

      snapshot: function(cb) {
        rpc("evm_snapshot", cb);
      },

      revert: function(snapshot_id, cb) {
        rpc("evm_revert", [snapshot_id, true], cb);
      }
    };

    global.contract = function(name, opts, tests) {
      if (typeof opts == "function") {
        tests = opts;
        opts = {
          reset_state: false
        };
      }

      if (opts.reset_state == null) {
        opts.reset_state = false;
      }

      describe(`Contract: ${name}`, function() {
        this.timeout(TEST_TIMEOUT);

        //var _original_contracts = {};

        before("reset evm before each suite", function(done) {
          this.timeout(BEFORE_TIMEOUT);

          if (!Truffle.can_revert) {
            return done();
          }
          Truffle.reset(function(err, res) {
            if (res.error && res.error.code && res.error.code !== 0) {
              Truffle.can_revert = false;
            }
            done();
          });
        });

        before("redeploy before each suite", function(done) {
          this.timeout(BEFORE_TIMEOUT);

          redeploy_contracts.call(this, config, false, function(err) {

            // Store address that was first deployed, in case we redeploy
            // from within a test
            // for (var name in config.contracts.classes) {
            //   var contract = global[name];
            //   _original_contracts[name] = contract.address;
            // }

            done(err);
          });
        });

        after("clear all filters after each suite", function(done) {
          Truffle.log_filters.forEach(function(f) { f.stopWatching(); });
          Truffle.log_filters = [];
          done();
        });

        // afterEach("restore contract address", function(done) {
        //   for (var name in _original_contracts) {
        //     global[name].address = _original_contracts[name];
        //   }
        //   done();
        // });

        afterEach("check logs on failure", function(done) {
          if (this.currentTest.state == "failed") {
            var logs = [];
            Truffle.log_filters.forEach(function(filter) {
              try {
                logs = logs.concat(filter.get());
              } catch (e) {
                if (e.message.match(/Invalid parameters/)) {
                  // filter is invalid because the contract no longer exists
                  filter.stopWatching();
                }
              }
            });
            logs.sort(function(a, b) {
              var ret = a.blockNumber - b.blockNumber;
              if (ret == 0) {
                return a.logIndex - b.logIndex;
              }
              return ret;
            });

            if (logs.length > 0) {
              console.log("\n    Events emitted during test:");
              console.log(  "    ---------------------------");
              console.log("");
              logs.forEach(function(log) {
                if (!log.event) {
                  return; // only want log events
                }
                if (log.event.toLowerCase() == "debug") {
                  console.log("[DEBUG]", log.args.msg);
                  return;
                }
                var line = `    ${log.event}(`;
                var first = true;
                for (var key in log.args) {
                  if (first == false) {
                    line += ", ";
                  } else {
                    first = false;
                  }
                  var value = log.args[key].toString();
                  line += `${key}: ${value}`;
                }
                line += ")";
                console.log(line);
              });
              console.log(  "\n    ---------------------------");
            } else {
              console.log("    > No events were emitted");
            }
          }
          done();
        });

        if (opts.reset_state == true) {
          var snapshot_id;
          beforeEach("snapshot state before each test", function(done) {
            if (!Truffle.can_revert) {
              // can't snapshot/revert, redeploy instead
              return redeploy_contracts(false, done);
            }
            Truffle.snapshot(function(err, ret) {
              snapshot_id = ret.result;
              done();
            });
          });

          afterEach("revert state after each test", function(done) {
            if (!Truffle.can_revert) {
              return done();
            }
            Truffle.revert(snapshot_id, function(err, ret) {
              done();
            });
          });
        }

        tests(accounts);
      });
    };


    // Get the accounts
    web3.eth.getAccounts(function(error, accs) {
      for (var account of accs) {
        accounts.push(account);
      }

      Pudding.defaults({
        from: accounts[0],
        gas: 3141592
      });

      if (config.argv.compile === false) {
        callback();
        return;
      }

      // Compile all the contracts and get the available accounts.
      // We only need to do this once, and can get it outside of
      // mocha.
      console.log("Compiling contracts...");
      Contracts.compile_all(config, function(err) {
        if (err != null) {
          callback(err);
          return;
        }

        callback();
      });
    });
  },

  run(config, file, callback) {
    // Override console.warn() because web3 outputs gross errors to it.
    // e.g., https://github.com/ethereum/web3.js/blob/master/lib/web3/allevents.js#L61
    // Output looks like this during tests: https://gist.github.com/tcoulter/1988349d1ec65ce6b958
    var warn = console.warn;
    console.warn = function(message) {
      if (message == "cannot find event for log") {
        return;
      } else {
        warn.apply(console, arguments);
      }
    };

    if (typeof file == "function") {
      callback = file;
      file = null;
      config.expect(config.tests.directory, "tests directory");
    }

    if (file != null) {
      if (path.isAbsolute(file) == false) {
        file = path.resolve(config.working_dir, file);
      }

      config.expect(file, "test file");
    }

    this.setup(config, function(err) {
      if (err != null) {
        callback(err);
        return;
      }

      // Change current working directory to that of the project.
      process.chdir(config.working_dir);
      __dirname = process.cwd();

      // If errors aren't caught in Promises, make sure they're thrown
      // and don't keep the process open.
      Promise.onPossiblyUnhandledRejection(function(e, promise) {
        throw e;
      });

      var mocha = new Mocha({
        useColors: true
      });

      var runMocha = function() {
        // TODO: Catch any errors here, and fail.
        mocha.run(function(failures) {
          callback(null, failures);
        });
      };

      if (file != null) {
        mocha.addFile(file);
        runMocha();
        return;
      }

      dir.files(config.tests.directory, function(err, files) {
        if (err != null) {
          callback(err);
          return;
        }

        // if running via the 'watch:tests' task, we want to be able to run
        // (require) our test files repeatedly, so this is a hack to make it
        // work. we copy each test file to a temp filename and load that
        // instead of the original to avoid getting cached.
        // files = files.map(function(f) {
        //   var src = fs.readFileSync(f);
        //   f = temp.path({prefix: "truffle-", suffix: "-"+path.basename(f)})
        //   fs.writeFileSync(f, src);
        //   return f;
        // });

        var mocha = new Mocha({
          useColors: true
        });

        for (var file of files.sort()) {
          mocha.addFile(file);
        }

        // Change current working directory to that of the project.
        process.chdir(config.working_dir);
        __dirname = process.cwd();

        // If errors aren't caught in Promises, make sure they're thrown
        // and don't keep the process open.
        Promise.onPossiblyUnhandledRejection(function(e, promise) {
          throw e;
        });

        // TODO: Catch any errors here, and fail.
        mocha.run(function(failures) {
          // files.forEach(function(f) {
          //   fs.unlinkSync(f); // cleanup our temp files
          // });
          console.warn = warn;
          callback(null, failures);
        });
      });
    });
  }
};

module.exports = Test;
