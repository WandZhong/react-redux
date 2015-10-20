var Mocha = require("mocha");
var chai = require("chai");
var dir = require("node-dir");
var path = require("path");

var Contracts = require("./contracts");
var Provision = require("./provision");

var Pudding = require("ether-pudding");
var loadconf = require("./loadconf");
var Promise = require("bluebird");

var ExtendableError = require("./errors/extendableerror");

// Make Promise global so tests have access to it.
global.Promise = Promise;

// Use custom assertions.
global.assert = chai.assert;
chai.use(require("./assertions"));

var Test = {
  setup(config, callback) {
    // Use the user-specified version of web3 in the tests.
    global.web3 = require(config.tests.web3);;
    config.setProviderFor(web3);

    // Variables that are passed to each contract which are
    // populated by the global before() hook.
    var accounts = [];

    var BEFORE_TIMEOUT = 120000;
    var TEST_TIMEOUT = 300000;

    global.contract = function(name, tests) {
      describe(`Contract: ${name}`, function() {
        this.timeout(TEST_TIMEOUT);

        before("redeploy before each contract", function(done) {
          this.timeout(BEFORE_TIMEOUT);

          // Redeploy contracts before each contract suite,
          // but don't recompile.
          Contracts.deploy(config, false, function(err) {
            if (err != null) {

              // Format our error messages so they print better with mocha.
              if (err instanceof ExtendableError) {
                err.formatForMocha();
              }

              done(err);
              return;
            }

            // Prepare the newly deployed contract classes, using the provisioner.
            loadconf(config.environments.current.contracts_filename, function(err, json) {
              config.contracts.classes = json;

              Pudding.setWeb3(web3);

              var provisioner = Provision.asModule(config);
              provisioner.provision_contracts(global);

              done();
            });


          });
        });

        tests(accounts);
      });
    };

    // Compile all the contracts and get the available accounts.
    // We only need to do this one, and can get it outside of
    // mocha.
    Contracts.compile_all(config, function(err) {
      if (err != null) {
        callback(err);
        return;
      }

      web3.eth.getAccounts(function(error, accs) {
        for (var account of accs) {
          accounts.push(account);
        }

        Pudding.defaults({
          from: accounts[0],
          gas: 3141592
        });

        callback();
      });
    });
  },

  // file must be absolute, or null.
  run(config, file, callback) {
    if (typeof file == "function") {
      callback = file;
      file = null;
      config.expect(config.tests.directory, "tests directory");
    } else {
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

        for (var file of files.sort()) {
          mocha.addFile(file);
        }

        runMocha();
      });
    });
  }
};

module.exports = Test;
