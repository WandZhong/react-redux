fs = require "fs"
dir = require "node-dir"
deasync = require "deasync"
filesSync = deasync(dir.files)
subdirSync = deasync(dir.subdirs)
jsmin = require("jsmin").jsmin
_ = require "lodash"
web3 = require "web3"

loadconf = deasync(require "./loadconf")

class Config
  @gather: (truffle_dir, working_dir, grunt) ->
    config = {}
    config = _.merge config, 
      grunt: grunt
      truffle_dir: truffle_dir
      working_dir: working_dir
      environment: process.env.NODE_ENV || grunt.option("e") || grunt.option("environment") || "development"
      environments: 
        directory: "#{working_dir}/config"
        available: {}
        current: {}       
      app:
        configfile: "#{working_dir}/config/app.json"
        # Default config objects that'll be overwritten by working_dir config.
        javascripts: []
        stylesheets: []
        deploy: []
        rpc: {}
        processors: {}
      javascripts: 
        directory: "#{working_dir}/app/javascripts"
      stylesheets: 
        directory: "#{working_dir}/app/stylesheets"
      html: 
        filename: "#{working_dir}/app/index.html"
      assets:
        directory: "#{working_dir}/app/assets"
      example:
        directory: "#{truffle_dir}/example"
        contract:
          directory: "#{truffle_dir}/example/app/contracts"
          filename: "#{truffle_dir}/example/app/contracts/Example.sol"
          name: "Example"
          variable: "example"
        test:
          directory: "#{truffle_dir}/example/test"
          filename: "#{truffle_dir}/example/test/example.coffee" 
      contracts:
        classes: {}
        directory: "#{working_dir}/app/contracts"
      tests:
        directory: "#{working_dir}/test"
      build:
        directory: "#{working_dir}/build"
        javascript_filename: "#{working_dir}/build/app.js"
        stylesheet_filename: "#{working_dir}/build/app.css"
        html_filename: "#{working_dir}/build/index.html"
        assets:
          directory: "#{working_dir}/build/assets"
      dist:
        directory: "#{working_dir}/dist"
        javascript_filename: "#{working_dir}/dist/app.js"
        stylesheet_filename: "#{working_dir}/dist/app.css"
        html_filename: "#{working_dir}/dist/index.html"
        assets:
          directory: "#{working_dir}/dist/assets"
    
    config.environments.current.directory = "#{config.environments.directory}/#{config.environment}"
    config.environments.current.filename = "#{config.environments.current.directory}/config.json"
    config.environments.current.contracts_filename = "#{config.environments.current.directory}/contracts.json"

    # Get environments in working directory, if available.
    if fs.existsSync(config.environments.directory)
      for directory in subdirSync(config.environments.directory)
        name = directory.substring(directory.lastIndexOf("/") + 1)
        config.environments.available[name] = directory

    # Load the app config.
    if fs.existsSync(config.app.configfile)
      config.app = loadconf(config.app.configfile, config.app)

    # Now overwrite any values from the environment config.
    if fs.existsSync(config.environments.current.filename)
      config.app = loadconf(config.environments.current.filename, config.app)

    # Get contracts in working directory, if available.
    if fs.existsSync(config.contracts.directory)
      for file in filesSync(config.contracts.directory)
        name = file.substring(file.lastIndexOf("/") + 1, file.lastIndexOf("."))
        config.contracts.classes[name] = {
          source: file
        }

    config.provider = new web3.providers.HttpProvider("http://#{config.app.rpc.host}:#{config.app.rpc.port}")

    # # If you want to see what web3 is sending and receiving.
    # oldAsync = config.provider.sendAsync
    # config.provider.sendAsync = (options, callback) ->
    #   console.log config.provider
    #   console.log "   > " + JSON.stringify(options, null, 2).split("\n").join("\n   > ")
    #   oldAsync.call config.provider, options, (error, result) ->
    #     if !error?
    #       console.log " <   " + JSON.stringify(result, null, 2).split("\n").join("\n <   ")
    #     callback(error, result)

    config.expect = (path, description, extra="") ->
      if !fs.existsSync(path)
        display_path = "." + path.replace(@working_dir, "")
        console.log "Couldn't find #{description} at #{display_path}. #{extra}"
        process.exit(1) 

    return config

  

module.exports = Config