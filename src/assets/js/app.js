/*global $, DigitalOcean, bip39*/
$(function () {
  "use strict";

  var ViewState = {
    droplets: [],
  };

  window.App = {
    createvps: createvps,
    data: ViewState,
  };

  //
  // MiniProvistor client-side application logic begins
  //

  // Set limits on how fast/much we poll for a new droplet to be active
  // Try every 5 seconds for 10 minutes
  var getDropletStateMaxAttempts = 120;
  var getDropletStatePollInterval = 5000;


  // Set limits on how fast/much we poll for a provisioning to finish
  // Try every 30 seconds for 10 minutes
  var getReadyStatusMaxAttempts = 120;
  var getReadyStatusPollInterval = 30000;

  // Create vps creates and sets up a droplet for production OpenBazaar use
  function createvps(caller, cloudInitScriptTemplate) {
    $("#dasinfo").html("<code>Working... please wait. Your droplet and OpenBazaar node details will be show below in 2-3 minutes.</code>");

    // Get the form calling this method
    var $form = $(caller).parents("form");

    // Disable form submission
    $form.find("submit, button").attr("disabled", true);

    // Get the required inputs from the form and validate them as much as we can
    var inputs = getInputsFromForm($form);

    // Generate passwords
    var vpsPassword = bip39.generateMnemonic();
    var obPassword = bip39.generateMnemonic();
    var sessionSecret = bip39.generateMnemonic(256);

    // Create a DO client
    var doClient = new DigitalOcean(inputs.token);

    // Create the cloud init script from the template
    var cloudInitScript = cloudInitScriptTemplate
      .replace("{{vpsPassword}}", vpsPassword)
      .replace("{{obPassword}}", obPassword)
      .replace("{{sessionSecret}}", sessionSecret);

    var dropletName = "obdroplet-" + (new Date().getTime());

    // Perform the provisioning
    doClient.createDroplet({
      size: "512mb",
      region: "sfo1",
      image: "ubuntu-14-04-x64",
      name: dropletName,
      user_data: cloudInitScript
    })

    // After creating the droplet we need to wait for it to be active
    .then(function (data) {
      return waitForCreation(doClient, data.droplet.id);
    })

    // Once it's active show a message to the user with their details and wait
    // for the provising to be finished
    .then(function (data) {
      // Create a droplet object and add it to the view state
      var droplet = {
        name: dropletName,
        ipv4: data.droplet.networks.v4[0].ip_address,
        obUsername: "admin",
        vpsUsername: "openbazaar",
        state: "INSTALLING_OB_RELAY",
      };

      ViewState.droplets.push(droplet);

      // Show a message to the user indicating we're building their server
      $("#dasinfo").html("Your Digital Ocean droplet was created and can be found at <kbd>" + droplet.ipv4 +
        "</kbd>. OpenBazaar is now installing.</br></br><u>To login to your droplet via SSH:</u></br>Droplet username: <code>openbazaar</code></br>Droplet password: <code>" + vpsPassword + "</code></br></br>The OpenBazaar node is installing on your droplet and should be ready in <strong>5-7 minutes</strong>.</br></br><u>To login to your OpenBazaar node:</u></br>Username: <code>admin</code></br>OB password: <code>" + obPassword + "</code></br></br><strong>Save these details immediately!</strong>");

      // Now just wait for everything to be ready
      return waitForReadyState(droplet);
    })

    // Droplet is created and provisioned. User can now login and use their store.
    .done(function (droplet) {
      console.log("Finished provising droplet:");
      console.log(JSON.stringify(droplet));
    })

    // Show error message upon failure
    .fail(function (err) {
      handleError(err);

      // A 401 most likely means we have an invalid API token
      if (JSON.stringify(err.status) == 401) {
        $("#dasinfo").html("<code>" + JSON.stringify(err.responseJSON.message) + "</code></br></br><code>Please check that your API token is correct.</code>");
        $form.find("submit, button").attr("disabled", false);
        return;
      } else if (err.responseJSON && err.responseJSON.message) {
        $("#dasinfo").html("<code>" + JSON.stringify(err.responseJSON.message) + "</code>.");
      } else {
        $("#dasinfo").html("An unknown error has occured.");
      }
    });
  }

  //
  // Private methods
  //

  // handleError logs the error and shows it to the  user
  function handleError() {
    console.log("error creating droplet");
    return false;
  }

  // getInputsFromForm returns an object with the required inputs for node creation
  function getInputsFromForm($form) {
    return {
      token: $form.find("input[name=token]").val(),
      size: $form.find("input[name=size]").val(),
      region: $form.find("input[name=region]").val()
    };
  }

  // waitForCreation polls the api X times trying to get the ip
  function waitForCreation(doClient, dropletId) {
    var deferred = $.Deferred(),
      attempts = 0;

    // poll gets droplet data and if an ipv4 exists we stop, otherwise keep going
    // until the configured stopping point
    function poll() {
      doClient.getDroplet(dropletId)

      // If the request was successful check if the droplet is active. If so we
      // are done. If not try again. If we've hit the limit fail.
      .done(function (data) {
        var droplet = data.droplet || {};
        if (droplet.status === "active" && droplet.networks.v4.length) {
          return deferred.resolve(data);
        }

        if (attempts >= getDropletStateMaxAttempts) {
          deferred.reject(new Error("Too many attempts"));
        }

        attempts++;
        setTimeout(poll, getDropletStatePollInterval);
      })

      // If the request fails just reject the promise
      .fail(deferred.reject);
    }

    // Start polling
    poll();

    // Return a promise to try really hard or fail
    return deferred.promise();
  }

  // waitForReadyState waits for ob-relay to report the READY status
  function waitForReadyState(droplet) {
    var deferred = $.Deferred(),
      attempts = 0;

    var statusAddr = "http://" + droplet.ipv4 + ":8080/status";

    function poll() {
      $.get(statusAddr)

      // If the request was successful see if we're in the READY status. If so we
      // are done. If not try again unless we're at our limit.
      .always(function (data, requestStatus) {
        // Update the droplet state if the request was successful. If it's READY
        // we're done so resolve the promise with the droplet.
        if (requestStatus === "success") {
          droplet.state = data.status;
          if (droplet.state === "READY") return deferred.resolve(droplet);
        }

        // Ensure we haven't tried too many times
        if (attempts >= getReadyStatusMaxAttempts) return deferred.reject(new Error("Too many attempts"));

        // Try again later
        attempts++;
        setTimeout(poll, getReadyStatusPollInterval);
      });
    }

    // Start polling
    poll();

    // Return a promise to try really hard or fail
    return deferred.promise();
  }
});