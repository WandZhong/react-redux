var Mocha = require("mocha");
var Suite = require("mocha/lib/suite.js");
var TestCase = require("mocha/lib/test.js");
var chai = require("chai");
var path = require("path");
var fs = require("fs");
var Web3 = require("web3");
var Config = require("truffle-config");
var Contracts = require("./contracts");
var Resolver = require("truffle-resolver");
var TestRunner = require('./testing/testrunner');
var TestResolver = require("./testing/testresolver");
var TestSource = require("./testing/testsource");
var expect = require("truffle-expect");
var find_contracts = require("truffle-contract-sources");
var SolidityUtils = require("truffle-solidity-utils");
var async = require("async");

chai.use(require("./assertions"));

var BEFORE_TIMEOUT = 120000;
var TEST_TIMEOUT = 300000;

var Test = {
  run: function(options, callback) {
    expect.options(options, [
      "contracts_directory",
      "contracts_build_directory",
      "migrations_directory",
      "test_files",
      "network",
      "network_id",
      "provider",
    ]);

    var config = Config.default().with(options);

    // `accounts` will be populated before each contract() invocation
    // and passed to it so tests don't have to call it themselves.
    var web3 = new Web3();
    web3.setProvider(options.provider);

    var accounts = [];

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

    // Allow people to specify options.mocha in their config.
    var mochaConfig = options.mocha || {};

    // If the command line overrides color usage, use that.
    if (options.colors != null) {
      mochaConfig.useColors = options.colors;
    }

    // Default to true if configuration isn't set anywhere.
    if (mochaConfig.useColors == null) {
      mochaConfig.useColors = true;
    }

    // Set up mocha and add the test files to it.
    var mocha = new Mocha(mochaConfig);

    var js_tests = options.test_files.filter(function(file) {
      return path.extname(file) != ".sol";
    });

    var sol_tests = options.test_files.filter(function(file) {
      return path.extname(file) == ".sol";
    });

    // Add Javascript tests because there's nothing we need to do with them.
    // Solidity tests will be handled later.
    js_tests.forEach(function(file) {
      mocha.addFile(file);
    });

    var dependency_paths = [];
    var testContracts = [];
    var testFiles = [];
    var runner;

    var test_resolver;

    async.series([
      // Get accounts available
      function(c) {
        web3.eth.getAccounts(function(err, accs) {
          if (err) return c(err);
          accounts = accs;

          if (!config.from) {
            config.from = accounts[0];
          }

          if (!config.resolver) {
            config.resolver = new Resolver(config);
          }

          var test_source = new TestSource(config);
          test_resolver = new TestResolver(config.resolver, test_source);

          c();
        });
      },
      // Get all contracts in the contracts directory as well as the
      // test directory, and compile them together. Note this will only
      // compile what's necessary.
      function(c) {
        async.parallel({
          contract_files: find_contracts.bind(find_contracts, options.contracts_directory),
          test_files: find_contracts.bind(find_contracts, options.test_directory)
        }, function(err, result) {
          if (err) return c(err);

          testFiles = result.test_files || [];

          // Compile project contracts and test contracts
          Contracts.compile(config.with({
            all: options.compileAll === true,
            files: result.contract_files.concat(result.test_files),
            resolver: test_resolver,
            quiet: false,
            quietWrite: true
          }), function(err, abstractions, dependency_paths) {
            if (err) return c(err);

            // Now that we have all possible dependencies for our solidity
            // tests, set up the test runner.
            runner = new TestRunner(config.with({
              dependency_paths: dependency_paths
            }));

            c();
          });
        })
      },
      // Require test contracts
      function(c) {
        testContracts = testFiles.map(function(test_file_path) {
          var built_name = "./" + path.basename(test_file_path);
          return test_resolver.require(built_name, config.contracts_build_directory);
        });

        c();
      },
      // Reorder the abis of solidity tests so that their functions
      // are in the same order as they exist in the code.
      function(c) {
        var file_hash = {};

        sol_tests.forEach(function(file) {
          var contract_name = path.basename(file, ".sol");
          file_hash[contract_name] = file;
        });

        async.each(testContracts, function(contract, finished) {
          var file = file_hash[contract.contract_name];

          SolidityUtils.ordered_abi(file, contract.abi, contract.contract_name, function(err, ordered) {
            if (err) return finished(err);

            contract.abi = ordered;
            finished();
          });
        }, c);
      },
      // Load up solidity tests contracts and create suites for each one
      function(c) {
        testContracts.forEach(function(contract) {
          var suite = new Suite(contract.contract_name);
          suite.timeout(BEFORE_TIMEOUT);

          // Set up our runner's needs first.
          suite.beforeAll("prepare suite", function(done) {
            runner.initializeSolidityTest(contract, done);
          });

          suite.beforeEach("before test", function(done) {
            runner.startTest(this, done);
          });

          // Function that checks transaction logs to see if a test failed.
          function processResult(result) {
            result.logs.forEach(function(log) {
              if (log.event == "TestEvent" && log.args.result == false) {
                throw new Error(log.args.message);
              }
            })
          };

          // Add functions from test file.
          contract.abi.forEach(function(item) {
            if (item.type != "function") return;

            ["beforeAll", "beforeEach", "afterAll", "afterEach"].forEach(function(fn_type) {
              if (item.name.indexOf(fn_type) == 0) {
                suite[fn_type](item.name, function(done) {
                  var deployed = contract.deployed();
                  return deployed[item.name]().then(processResult).then(done).catch(done);
                });
              }
            });

            if (item.name.indexOf("test") == 0) {
              var test = new TestCase(item.name, function(done) {
                var deployed = contract.deployed();
                return deployed[item.name]().then(processResult).then(done).catch(done);
              });

              test.timeout(TEST_TIMEOUT);
              suite.addTest(test);
            }
          });

          suite.afterEach("after test", function(done) {
            runner.endTest(this, done);
          });

          mocha.suite.addSuite(suite);
        });

        c();
      },
      // Set globals and helpers for Javascript tests.
      function(c) {
        global.web3 = web3;
        global.assert = chai.assert;
        global.artifacts = {
          require: function(import_path) {
            return runner.config.resolver.require(import_path);
          }
        }

        global.contract = function(name, tests) {
          if (typeof opts == "function") {
            tests = name;
            name = "";
          }

          describe("Contract: " + name, function() {
            this.timeout(TEST_TIMEOUT);

            before("prepare suite", function(done) {
              this.timeout(BEFORE_TIMEOUT);
              runner.initialize(done);

            });

            beforeEach("before test", function(done) {
              runner.startTest(this, done);
            });

            afterEach("after test", function(done) {
              runner.endTest(this, done);
            });

            tests(accounts, config.resolver);
          });
        };

        c();
      },
      // Run tests.
      function(c) {
        process.on('unhandledRejection', function(reason, p) {
          throw reason;
        });

        mocha.run(function(failures) {
          console.warn = warn;
          c(failures);
        });
      }
    ], callback);
  }
};

module.exports = Test;
