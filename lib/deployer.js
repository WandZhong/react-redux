var EventEmitter = require("events").EventEmitter;
var inherits = require("util").inherits;
var Linker = require("./linker");
var Require = require("./require");
var expect = require("./expect");
var path = require("path");

var Actions = {
  deploy: function(contract, args, logger) {
    return new Promise(function(accept, reject) {
      var prefix = "Deploying ";
      if (contract.address != null) {
        prefix = "Replacing ";
      }

      logger.log(prefix + contract.contract_name + "...");

      // Evaluate any arguments if they're promises
      Promise.all(args).then(function(new_args) {
        return contract.new.apply(contract, new_args);
      }).then(function(instance) {
        logger.log(contract.contract_name + ": " + instance.address);
        contract.address = instance.address;
        accept();
      }).catch(reject);
    });
  }
};


inherits(Deployer, EventEmitter);

function Deployer(options) {
  Deployer.super_.call(this);
  var self = this;
  options = options || {};

  expect.options(options, [
    "provider",
    "network",
    "network_id"
  ]);

  this.chain = new Promise(function(accept, reject) {
    self._accept = accept;
    self._reject = reject;
  });
  this.logger = options.logger || console;
  if (options.quiet) {
    this.logger = {log: function() {}};
  }
  this.known_contracts = {};
  (options.contracts || []).forEach(function(contract) {
    self.known_contracts[contract.contract_name] = contract;
  });
  this.network = options.network;
  this.network_id = options.network_id;
  this.provider = options.provider;
  this.basePath = options.basePath || process.cwd();
  this.started = false;
};

// Note: In all code below we overwrite this.chain every time .then() is used
// in order to ensure proper error processing.

Deployer.prototype.start = function() {
  var self = this;
  return new Promise(function(accept, reject) {
    self.chain = self.chain.then(accept).catch(reject);
    self.started = true;
    self._accept();
  });
};

Deployer.prototype.autolink = function(contract) {
  var self = this;
  this.checkStarted();

  // autolink all contracts available.
  if (contract == null) {
    Object.keys(this.known_contracts).forEach(function(contract_name) {
      self.autolink(self.known_contracts[contract_name]);
    });
    return;
  }

  var self = this;
  var regex = /__[^_]+_+/g;

  this.chain = this.chain.then(function() {
    Linker.autolink(contract, self.known_contracts, self.logger);
  });
};

Deployer.prototype.link = function(library, destinations) {
  this.checkStarted();

  var self = this;

  this.chain = this.chain.then(function() {
    Linker.link(library, destinations, self.logger);
  });
};

Deployer.prototype.deploy = function() {
  this.checkStarted();

  var self = this;
  var args = Array.prototype.slice.call(arguments);
  var contract = args.shift();

  if (Array.isArray(contract)) {
    return this.deployMany(contract);
  }

  this.chain = this.chain.then(function() {
    return Actions.deploy(contract, args, self.logger);
  });

  return this.chain;
};

Deployer.prototype.deployMany = function(arr) {
  var self = this;
  this.chain = this.chain.then(function() {
    var deployments = arr.map(function(args) {
      var contract;

      if (Array.isArray(args)) {
        contract = args.shift();
      } else {
        contract = args;
        args = [];
      }

      return Actions.deploy(contract, args, self.logger);
    });
    return Promise.all(deployments);
  });

  return this.chain;
};

Deployer.prototype.new = function() {
  this.checkStarted();

  var self = this;
  var args = Array.prototype.slice.call(arguments);
  var contract = args.shift();
  this.chain = this.chain.then(function() {
    self.logger.log("Creating new instance of " + contract.contract_name);
    // Evaluate any arguments if they're promises
    return Promise.all(args);
  }).then(function(new_args) {
    return contract.new.apply(contract, args)
  });
  return this.chain;
};

Deployer.prototype.exec = function(file) {
  this.checkStarted();

  var self = this;

  if (path.isAbsolute(file) == false) {
    file = path.resolve(path.join(this.basePath, file));
  }

  this.chain = this.chain.then(function() {
    self.logger.log("Running " + file + "...");
    // Evaluate any arguments if they're promises
    return new Promise(function(accept, reject) {
      Require.exec({
        file: file,
        contracts: Object.keys(self.known_contracts).map(function(key) {
          return self.known_contracts[key];
        }),
        network: self.network,
        network_id: self.network_id,
        provider: self.provider
      }, function(err) {
        if (err) return reject(err);
        accept();
      });
    });
  });
};

Deployer.prototype.then = function(fn) {
  this.checkStarted();

  var self = this;
  this.chain = this.chain.then(function() {
    self.logger.log("Running step...");
    return fn();
  });
  return this.chain;
}

Deployer.prototype.checkStarted = function() {
  if (this.started == true) {
    throw new Error("Can't add new deployment steps once the deploy has started");
  }
}

module.exports = Deployer;
