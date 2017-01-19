var assert = require("chai").assert;
var path = require("path");
var fs = require("fs");
var Init = require("../lib/init");
var Contracts = require("../lib/contracts");
var TestRPC = require("ethereumjs-testrpc");
var provision = require("truffle-provisioner");
var Resolver = require("truffle-resolver");
var Artifactor = require("truffle-artifactor");

describe('config', function() {
  var config;
  var customRPCConfig = {
    gas: 90000,
    gasPrice: 2,
    from: "0x1234567890123456789012345678901234567890"
  };

  before("Create a sandbox with extra config values", function(done) {
    this.timeout(5000);
    Init.sandbox({
      quiet: true
    }, function(err, result) {
      if (err) return done(err);
      config = result;
      config.provider = TestRPC.provider();
      config.resolver = new Resolver(config);
      config.artifactor = new Artifactor(config.contracts_build_directory);
      config.network = "development";
      config.networks = {
        development: {
          network_id: "1",
          gas: customRPCConfig.gas,
          gasPrice: customRPCConfig.gasPrice,
          from: "0x1234567890123456789012345678901234567890"
        }
      };

      done();
    });
  });

  before("Compile contracts", function(done) {
    this.timeout(5000);
    Contracts.compile(config, done);
  });

  it('Provisioning contracts should set proper RPC values', function() {
    var contract = config.resolver.require("MetaCoin.sol");

    provision(contract, config);

    assert.deepEqual(contract.defaults(), customRPCConfig);
  });

});
