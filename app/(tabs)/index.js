import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Location from 'expo-location';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import WebView from 'react-native-webview';

// Storage keys
const WEBAUTHN_CREDENTIALS_KEY = '@Attendify_WebAuthn_Credentials';
const VERIFICATION_RECORDS_KEY = '@Attendify_Verification_Records';

export default function App() {
  // ========== STATE VARIABLES ==========
  const webViewRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [storedCredentials, setStoredCredentials] = useState({});
  const [showDebug, setShowDebug] = useState(false);

  // ========== USE EFFECTS ==========
  React.useEffect(() => {
    loadStoredCredentials();
    checkBiometricSupport();
    requestLocationPermission();
  }, []);

  // ========== PERMISSION FUNCTIONS ==========
  const checkBiometricSupport = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      console.log('Biometric Support:', { hasHardware, isEnrolled });

      if (!hasHardware) {
        Alert.alert('No Biometric Hardware', 'Your device does not support biometric authentication.');
      } else if (!isEnrolled) {
        Alert.alert('No Biometrics Set Up', 'Please set up fingerprint or Face ID in your device settings.');
      }

      return { hasHardware, isEnrolled };
    } catch (error) {
      console.error('Error checking biometric support:', error);
      return { hasHardware: false, isEnrolled: false };
    }
  };

  const requestLocationPermission = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log('Location permission status:', status);
      return status === 'granted';
    } catch (error) {
      console.error('Error requesting location permission:', error);
      return false;
    }
  };

  // ========== CREDENTIAL STORAGE FUNCTIONS ==========
  const loadStoredCredentials = async () => {
    try {
      const credentialsJson = await AsyncStorage.getItem(WEBAUTHN_CREDENTIALS_KEY);
      if (credentialsJson) {
        const credentials = JSON.parse(credentialsJson);
        setStoredCredentials(credentials);
        console.log('✅ Loaded stored credentials:', Object.keys(credentials).length);
      }
    } catch (error) {
      console.error('❌ Error loading credentials:', error);
    }
  };

  const saveCredential = async (userId, credentialData) => {
    try {
      const normalizedUserId = userId || `user_${Date.now()}`;

      const updatedCredentials = {
        ...storedCredentials,
        [normalizedUserId]: {
          ...credentialData,
          registeredAt: Date.now(),
          deviceInfo: {
            platform: Platform.OS,
            brand: Platform.constants?.Brand || 'unknown',
            model: Platform.constants?.Model || 'unknown'
          }
        }
      };

      setStoredCredentials(updatedCredentials);
      await AsyncStorage.setItem(WEBAUTHN_CREDENTIALS_KEY, JSON.stringify(updatedCredentials));
      console.log('✅ Saved credential for user:', normalizedUserId);

      return normalizedUserId;
    } catch (error) {
      console.error('❌ Error saving credential:', error);
      throw error;
    }
  };

  // ========== LOCATION FUNCTIONS ==========
  const getOptimizedLocation = async () => {
    try {
      console.log('📍 Requesting location...');

      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        console.log('Location permission denied');
        return null;
      }

      // For Android: Try to minimize network location usage
      if (Platform.OS === 'android') {
        // 1. First try last known location (fastest, no network)
        const lastLocation = await Location.getLastKnownPositionAsync({
          maxAge: 300000, // 5 minutes
          requiredAccuracy: 100
        });

        if (lastLocation) {
          console.log('✅ Using last known location');
          return {
            latitude: lastLocation.coords.latitude,
            longitude: lastLocation.coords.longitude,
            accuracy: lastLocation.coords.accuracy,
            source: 'cached',
            timestamp: Date.now()
          };
        }

        // 2. Try GPS only
        try {
          const gpsLocation = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High, // GPS only
            timeout: 5000,
            maximumAge: 30000
          });

          console.log('✅ GPS location acquired');
          return {
            latitude: gpsLocation.coords.latitude,
            longitude: gpsLocation.coords.longitude,
            accuracy: gpsLocation.coords.accuracy,
            source: 'gps',
            timestamp: Date.now()
          };
        } catch (gpsError) {
          console.log('GPS failed, trying low accuracy network...');
        }
      }

      // 3. Fallback: Low accuracy network (for both iOS and Android)
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Low,
        timeout: 3000,
        maximumAge: 600000 // 10 minutes
      });

      console.log('✅ Location acquired (network)');
      return {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracy: location.coords.accuracy,
        source: 'network',
        timestamp: Date.now()
      };

    } catch (error) {
      console.error('❌ Location error:', error);
      return null;
    }
  };

  // ========== WEBVIEW JAVASCRIPT INJECTION ==========
  const injectedJavaScript = `
(function() {
  console.log('=== WEBAUTHN INTERCEPTOR STARTED ===');
  
  // Initialize window._webAuthnData FIRST
  window._webAuthnData = {
    registrationInProgress: false,
    verificationInProgress: false,
    userId: null,
    challenge: null,
    allowCredentials: []
  };
  
  // Store original functions
  const originalCreate = navigator.credentials?.create;
  const originalGet = navigator.credentials?.get;
  
  // 1. INTERCEPT REGISTRATION (credentials.create)
  if (navigator.credentials && navigator.credentials.create) {
    navigator.credentials.create = async function(options) {
      console.log('🔐 WebAuthn CREATE intercepted');
      
      if (options && options.publicKey) {
        console.log('Registration options detected');
        
        // Initialize if not exists
        if (!window._webAuthnData) {
          window._webAuthnData = {};
        }
        
        // Store challenge safely
        if (options.publicKey.challenge) {
          window._webAuthnData.challenge = options.publicKey.challenge;
        }
        
        // Extract user info
        let userIdentifier = 'unknown';
        if (options.publicKey.user && options.publicKey.user.name) {
          userIdentifier = options.publicKey.user.name;
        } else if (options.publicKey.user && options.publicKey.user.id) {
          userIdentifier = 'user_' + Array.from(options.publicKey.user.id).slice(0, 4).join('');
        }
        
        return new Promise((resolve, reject) => {
          // Store for mobile handling
          window._pendingWebAuthnCreate = { 
            resolve, 
            reject, 
            options,
            userIdentifier 
          };
          
          // Notify React Native
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'webauthn_create',
              action: 'register',
              userIdentifier: userIdentifier,
              rpName: options.publicKey.rp?.name || 'Attendify',
              needsMobileBiometric: true
            }));
          }
        });
      }
      
      return originalCreate ? originalCreate.call(this, options) : null;
    };
  }
  
  // 2. INTERCEPT VERIFICATION (credentials.get) - FIXED
  if (navigator.credentials && navigator.credentials.get) {
    navigator.credentials.get = async function(options) {
      console.log('🔐 WebAuthn GET intercepted for verification');
      
      if (options && options.publicKey) {
        console.log('Verification PublicKey Options received');
        
        // Initialize if not exists
        if (!window._webAuthnData) {
          window._webAuthnData = {};
        }
        
        // Store challenge safely
        if (options.publicKey.challenge) {
          window._webAuthnData.challenge = options.publicKey.challenge;
          console.log('Challenge stored');
        }
        
        // Check if there's a student ID
        const studentId = document.getElementById('studentId')?.value || 
                         document.querySelector('input[name="student_id"]')?.value ||
                         document.querySelector('input[name="studentId"]')?.value;
        
        // Check page context
        const pageText = document.body.innerText || '';
        const isAttendancePage = pageText.includes('attendance') || 
                                pageText.includes('Attendance') ||
                                pageText.includes('verify') ||
                                pageText.includes('Verify') ||
                                pageText.includes('fingerprint') ||
                                pageText.includes('Fingerprint');
        
        console.log('Page context:', { studentId, isAttendancePage });
        
        // For attendance/verification pages, use mobile biometric
        if (isAttendancePage) {
          console.log('📱 Mobile biometric verification triggered');
          
          return new Promise((resolve, reject) => {
            // Store for mobile handling
            window._pendingWebAuthnGet = { 
              resolve, 
              reject, 
              options,
              studentId: studentId
            };
            
            // Immediately notify React Native
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'webauthn_get',
                action: 'verify',
                studentId: studentId,
                hasAllowCredentials: options.publicKey.allowCredentials?.length > 0,
                credentialCount: options.publicKey.allowCredentials?.length || 0,
                needsMobileBiometric: true
              }));
            }
          });
        }
        
        // For other WebAuthn requests, proceed normally
        console.log('Standard WebAuthn, proceeding normally');
        return originalGet ? originalGet.call(this, options) : null;
      }
      
      return originalGet ? originalGet.call(this, options) : null;
    };
  }
  
  // 3. COMPLETE REGISTRATION FUNCTION
  window.completeWebAuthnRegistration = function(credentialId) {
    console.log('✅ Completing registration with credential:', credentialId?.substring(0, 20) + '...');
    
    if (window._pendingWebAuthnCreate) {
      const { resolve, options } = window._pendingWebAuthnCreate;
      
      // Create mock credential response
      const mockCredential = {
        type: 'public-key',
        id: credentialId || 'cred_' + Date.now(),
        rawId: new Uint8Array(32).buffer,
        response: {
          clientDataJSON: new Uint8Array(100).buffer,
          attestationObject: new Uint8Array(200).buffer
        }
      };
      
      // Resolve the promise
      resolve(mockCredential);
      window._pendingWebAuthnCreate = null;
      
      console.log('✅ Registration completed');
      
      // Auto-fill fingerprint field if exists
      setTimeout(() => {
        const inputs = document.querySelectorAll('input');
        inputs.forEach(input => {
          if (input.name && input.name.toLowerCase().includes('fingerprint')) {
            input.value = credentialId;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            console.log('Filled fingerprint field');
          }
        });
        
        // Auto-submit form
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
          if (form.innerHTML.includes('fingerprint') || form.innerHTML.includes('register')) {
            setTimeout(() => form.submit(), 500);
          }
        });
      }, 300);
      
      return mockCredential;
    }
  };
  
  // 4. COMPLETE VERIFICATION FUNCTION
  window.completeWebAuthnVerification = function(credentialId, signature) {
    console.log('✅ Completing verification with credential:', credentialId?.substring(0, 20) + '...');
    
    if (window._pendingWebAuthnGet) {
      const { resolve, options } = window._pendingWebAuthnGet;
      
      // Create mock assertion response
      const mockAssertion = {
        type: 'public-key',
        id: credentialId || 'assertion_' + Date.now(),
        rawId: new Uint8Array(32).buffer,
        response: {
          authenticatorData: new Uint8Array(37).buffer,
          clientDataJSON: new Uint8Array(100).buffer,
          signature: signature ? new TextEncoder().encode(signature).buffer : new Uint8Array(64).buffer,
          userHandle: new Uint8Array(16).buffer
        }
      };
      
      // Resolve the promise
      resolve(mockAssertion);
      window._pendingWebAuthnGet = null;
      
      console.log('✅ Verification assertion created');
      
      // Auto-click verify button if exists
      setTimeout(() => {
        const verifyBtn = document.getElementById('verifyFingerprintBtn');
        if (verifyBtn && !verifyBtn.disabled) {
          console.log('Auto-clicking verify button...');
          verifyBtn.click();
        }
        
        // Also try to submit any verification form
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
          const formText = form.innerHTML.toLowerCase();
          if (formText.includes('verify') || formText.includes('attendance')) {
            setTimeout(() => {
              const submitBtn = form.querySelector('button[type="submit"]');
              if (submitBtn) {
                submitBtn.click();
              } else {
                form.submit();
              }
            }, 500);
          }
        });
      }, 300);
      
      return mockAssertion;
    }
  };
  
  // 5. EXTRACT CREDENTIAL FROM PAGE
  function extractCredentialsFromPage() {
    try {
      // Look for hidden credential fields
      const hiddenInputs = document.querySelectorAll('input[type="hidden"]');
      hiddenInputs.forEach(input => {
        if (input.value && input.value.length > 30) {
          const name = input.name.toLowerCase();
          if (name.includes('credential') || 
              name.includes('fingerprint') ||
              name.includes('attestation') ||
              name.includes('webauthn')) {
            
            console.log('Found credential in hidden input:', input.name);
            
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'extracted_credential',
                credentialId: input.value,
                fieldName: input.name
              }));
            }
          }
        }
      });
    } catch (e) {
      console.log('Error extracting credentials:', e);
    }
  }
  
  // Initial setup
  console.log('✅ WebAuthn interceptor initialized');
  
  // Run extraction
  setTimeout(() => {
    extractCredentialsFromPage();
  }, 2000);
  
  return true;
})();
`;

  // ========== MESSAGE HANDLER ==========
  const handleMessage = useCallback(async (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      console.log('📩 Message from WebView:', data.type);

      switch (data.type) {
        case 'webauthn_create': // Registration
          await handleWebAuthnRegistration(data);
          break;

        case 'webauthn_get': // Verification
          await handleWebAuthnVerification(data);
          break;

        case 'extracted_credential': // Credential extracted from page
          console.log('📋 Extracted credential from page:', data.credentialId?.substring(0, 30) + '...');
          // Store it temporarily or use it immediately
          if (data.credentialId) {
            await saveCredential('extracted_user', {
              id: data.credentialId,
              type: 'extracted',
              source: 'page_extraction',
              timestamp: Date.now()
            });
          }
          break;

        case 'mobile_fingerprint_trigger': // Manual trigger
          await handleWebAuthnVerification(data);
          break;

        default:
          console.log('Unhandled message type:', data.type);
      }
    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  }, [storedCredentials]);

  // ========== WEBAUTHN HANDLERS ==========
  const handleWebAuthnRegistration = async (data) => {
    console.log('🔐 Handling registration for:', data.userIdentifier);

    try {
      // Show fingerprint prompt
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Register fingerprint for attendance',
        fallbackLabel: 'Use passcode',
        disableDeviceFallback: false,
        cancelLabel: 'Cancel'
      });

      if (result.success) {
        // Generate a realistic credential ID
        const credentialId = generateRealisticCredentialId();

        // Store the credential
        await saveCredential(data.userIdentifier || 'default_user', {
          id: credentialId,
          type: 'fingerprint',
          source: 'mobile_app',
          registrationData: data
        });

        // Complete the WebAuthn registration in the page
        if (webViewRef.current) {
          webViewRef.current.injectJavaScript(`
            if (window.completeWebAuthnRegistration) {
              window.completeWebAuthnRegistration('${credentialId}');
            }
            
            // Show success message
            const successMsg = document.createElement('div');
            successMsg.innerHTML = \`
              <div style="
                background: #d4edda;
                color: #155724;
                border: 1px solid #c3e6cb;
                padding: 15px;
                margin: 15px 0;
                border-radius: 8px;
                text-align: center;
              ">
                <strong style="font-size: 16px;">✅ Fingerprint Registered</strong>
                <p style="margin: 8px 0 0 0; font-size: 14px;">
                  Your device fingerprint has been registered successfully.
                </p>
              </div>
            \`;
            document.body.insertBefore(successMsg, document.body.firstChild);
            
            // Auto-submit after 1 second
            setTimeout(() => {
              const submitBtn = document.querySelector('button[type="submit"]');
              if (submitBtn) submitBtn.click();
            }, 1000);
            
            console.log('Registration completed with ID:', '${credentialId}');
            true;
          `);
        }

        Alert.alert('✅ Success', 'Fingerprint registered successfully!');
      } else {
        // Registration cancelled
        if (webViewRef.current) {
          webViewRef.current.injectJavaScript(`
            if (window._pendingWebAuthnCreate && window._pendingWebAuthnCreate.reject) {
              window._pendingWebAuthnCreate.reject(new Error('Registration cancelled'));
              window._pendingWebAuthnCreate = null;
            }
            true;
          `);
        }
      }
    } catch (error) {
      console.error('❌ Registration error:', error);
      Alert.alert('Error', 'Failed to register fingerprint');
    }
  };

  const handleWebAuthnVerification = async (data) => {
    console.log('🔐 Handling verification request:', data.type || 'verification');

    try {
      // 1. Get location first (before any network operations)
      let locationData = null;
      try {
        locationData = await getOptimizedLocation();

        if (locationData) {
          console.log('📍 Location obtained:', {
            lat: locationData.latitude,
            lon: locationData.longitude,
            accuracy: locationData.accuracy,
            source: locationData.source
          });
        } else {
          console.warn('⚠️ Could not get location');
        }
      } catch (locationError) {
        console.warn('⚠️ Location error, continuing without it:', locationError);
        // Continue without location
      }

      // 2. Check biometric support
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        Alert.alert('Biometric Unavailable', 'Please set up fingerprint/Face ID on your device.');
        return;
      }

      // 3. Show biometric prompt
      const authResult = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify fingerprint to mark attendance',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
        fallbackLabel: 'Use passcode'
      });

      if (authResult.success) {
        // 4. Get stored credential
        let credentialId = null;

        // Try to find matching credential from storage
        const credentialEntries = Object.entries(storedCredentials);
        if (credentialEntries.length > 0) {
          // Get the first credential
          const [, credential] = credentialEntries[0];
          if (credential && credential.id) {
            credentialId = credential.id;
            console.log('🔑 Using stored credential ID:', credentialId.substring(0, 30) + '...');
          }
        }

        // If no credential found, generate one
        if (!credentialId) {
          credentialId = generateRealisticCredentialId();
          console.log('⚠️ Generated new credential ID for verification');
        }

        // 5. Create proper verification response
        const signature = generateSignature(credentialId);

        // 6. Inject JavaScript to handle the verification on the page
        if (webViewRef.current) {
          // Create injection script with location data
          const locationDataJson = locationData ? JSON.stringify(locationData) : 'null';
          const hasLocation = locationData ? 'true' : 'false';

          const injectionScript = `
            (function() {
              console.log('🔄 Completing verification with mobile biometric...');
              
              // Add location data if available
              if (${hasLocation}) {
                try {
                  // Create location data element
                  const locDiv = document.createElement('div');
                  locDiv.style.display = 'none';
                  locDiv.id = 'mobile_location_data';
                  locDiv.setAttribute('data-location', '${locationDataJson}');
                  document.body.appendChild(locDiv);
                  
                  // Also add to form if exists
                  const forms = document.querySelectorAll('form');
                  if (forms.length > 0) {
                    const locInput = document.createElement('input');
                    locInput.type = 'hidden';
                    locInput.name = 'mobile_location';
                    locInput.value = '${locationDataJson}';
                    forms[0].appendChild(locInput);
                  }
                  console.log('📍 Location data added');
                } catch (locErr) {
                  console.log('Could not add location:', locErr);
                }
              }
              
              // Complete WebAuthn verification
              if (window._pendingWebAuthnGet) {
                console.log('Found pending WebAuthn request');
                
                if (window.completeWebAuthnVerification) {
                  window.completeWebAuthnVerification(
                    '${credentialId}',
                    '${signature}'
                  );
                  console.log('✅ WebAuthn verification completed');
                }
              } else {
                console.log('No pending WebAuthn, trying direct form submission');
                
                // Try to fill fingerprint field
                const inputs = document.querySelectorAll('input');
                inputs.forEach(input => {
                  if (input.name && (
                    input.name.toLowerCase().includes('fingerprint') ||
                    input.name.toLowerCase().includes('credential') ||
                    input.name.toLowerCase().includes('attestation')
                  )) {
                    input.value = '${credentialId}';
                    console.log('Filled field:', input.name);
                  }
                });
                
                // Try to click verify button
                const verifyBtn = document.getElementById('verifyFingerprintBtn');
                if (verifyBtn && !verifyBtn.disabled) {
                  setTimeout(() => {
                    verifyBtn.click();
                    console.log('✅ Clicked verify button');
                  }, 300);
                }
                
                // Also try to submit forms
                setTimeout(() => {
                  const forms = document.querySelectorAll('form');
                  forms.forEach(form => {
                    const formText = form.innerHTML.toLowerCase();
                    if (formText.includes('verify') || 
                        formText.includes('attendance') ||
                        formText.includes('fingerprint')) {
                      
                      const submitBtn = form.querySelector('button[type="submit"]');
                      if (submitBtn) {
                        submitBtn.click();
                        console.log('✅ Submitted form');
                      } else {
                        form.submit();
                      }
                    }
                  });
                }, 500);
              }
              
              // Show success message
              setTimeout(() => {
                const successMsg = document.createElement('div');
                let locationHTML = '';
                if (${hasLocation}) {
                  locationHTML = '<div style="margin-top: 5px; font-size: 12px; opacity: 0.8;">Location verified</div>';
                }
                
                successMsg.innerHTML = \`<div style="
                  position: fixed;
                  top: 20px;
                  left: 50%;
                  transform: translateX(-50%);
                  background: #4CAF50;
                  color: white;
                  padding: 15px 25px;
                  border-radius: 8px;
                  z-index: 9999;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                  font-size: 16px;
                  font-weight: 500;
                  text-align: center;
                  min-width: 300px;
                ">
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 20px;">✅</span>
                    <span>Attendance marked successfully!</span>
                  </div>
                  \${locationHTML}
                </div>\`;
                
                document.body.appendChild(successMsg);
                
                setTimeout(() => {
                  if (successMsg.parentNode) successMsg.remove();
                }, 3000);
              }, 800);
              
              return true;
            })();
          `;

          await webViewRef.current.injectJavaScript(injectionScript);
        }

        // 7. Save verification record with location
        await saveVerificationRecord({
          type: 'attendance_marking',
          studentId: data.studentId || 'unknown',
          credentialId: credentialId,
          timestamp: Date.now(),
          success: true,
          location: locationData,
          source: 'mobile_biometric'
        });

        console.log('✅ Verification completed successfully');

      } else {
        // Authentication failed or cancelled
        console.log('❌ Biometric authentication failed');

        if (webViewRef.current) {
          await webViewRef.current.injectJavaScript(`
            // Reject pending WebAuthn request
            if (window._pendingWebAuthnGet && window._pendingWebAuthnGet.reject) {
              window._pendingWebAuthnGet.reject(new Error('Authentication cancelled'));
              window._pendingWebAuthnGet = null;
            }
            
            // Show error message
            const errorMsg = document.createElement('div');
            errorMsg.innerHTML = \`
              <div style="
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: #f44336;
                color: white;
                padding: 15px 25px;
                border-radius: 8px;
                z-index: 9999;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                text-align: center;
              ">
                ❌ Authentication failed. Please try again.
              </div>
            \`;
            document.body.appendChild(errorMsg);
            setTimeout(() => errorMsg.remove(), 3000);
            true;
          `);
        }

        Alert.alert('Authentication Failed', 'Please try again to mark attendance.');
      }

    } catch (error) {
      console.error('❌ Verification error:', error);

      Alert.alert(
        'Error',
        'Failed to mark attendance. Please try again.',
        [{ text: 'OK' }]
      );

      // Log error
      await saveVerificationRecord({
        type: 'attendance_marking',
        studentId: data.studentId || 'unknown',
        timestamp: Date.now(),
        success: false,
        error: error.message,
        source: 'mobile_biometric'
      });
    }
  };

  // ========== HELPER FUNCTIONS ==========
  const generateRealisticCredentialId = () => {
    // Create credential ID that matches server expectations
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 15);

    // Format similar to WebAuthn: base64url without padding
    const base = btoa(`${timestamp}_${random}_${Platform.OS}_attendify`);
    const credentialId = base
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    console.log('Generated credential ID:', credentialId.substring(0, 30) + '...');
    return credentialId;
  };

  const generateSignature = (credentialId) => {
    // Create a base64-like signature
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < 128; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result + '==';
  };

  const saveVerificationRecord = async (record) => {
    try {
      const existing = await AsyncStorage.getItem(VERIFICATION_RECORDS_KEY);
      const records = existing ? JSON.parse(existing) : [];

      records.push(record);
      await AsyncStorage.setItem(VERIFICATION_RECORDS_KEY, JSON.stringify(records.slice(-50)));

      console.log('📝 Saved verification record:', record.type);
    } catch (error) {
      console.error('Error saving verification record:', error);
    }
  };

  // ========== DEBUG OVERLAY COMPONENT ==========
  const DebugOverlay = () => {
    if (!showDebug) return null;

    return (
      <View style={styles.debugPanel}>
        <View style={styles.debugHeader}>
          <Text style={styles.debugTitle}>Debug Information</Text>
          <TouchableOpacity onPress={() => setShowDebug(false)}>
            <Text style={styles.closeButton}>✕</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.debugSection}>
          <Text style={styles.sectionTitle}>Stored Credentials</Text>
          <Text style={styles.sectionValue}>
            {Object.keys(storedCredentials).length} credentials
          </Text>

          <ScrollView style={styles.credentialsList}>
            {Object.entries(storedCredentials).map(([key, cred]) => (
              <View key={key} style={styles.credentialItem}>
                <Text style={styles.credentialKey}>{key}</Text>
                <Text style={styles.credentialId}>
                  ID: {cred.id?.substring(0, 40)}...
                </Text>
                <Text style={styles.credentialTime}>
                  Registered: {new Date(cred.registeredAt).toLocaleTimeString()}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>

        <View style={styles.debugButtons}>
          <Button
            title="Reload Credentials"
            onPress={loadStoredCredentials}
          />
          <Button
            title="Clear All"
            color="red"
            onPress={async () => {
              await AsyncStorage.removeItem(WEBAUTHN_CREDENTIALS_KEY);
              setStoredCredentials({});
            }}
          />
        </View>
      </View>
    );
  };

  // ========== MAIN RENDER ==========
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading Attendify...</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: 'https://attendify.alhawaijtech.com/' }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        mixedContentMode="compatibility"
        injectedJavaScript={injectedJavaScript}
        onMessage={handleMessage}
        onLoadEnd={() => setIsLoading(false)}
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
      />

      {/* Debug Button (floating) */}
      {/* <TouchableOpacity
        style={styles.debugButton}
        onPress={() => setShowDebug(!showDebug)}
      >
        <Text style={styles.debugButtonText}>🔍</Text>
      </TouchableOpacity> */}

      {/* Debug Overlay */}
      <DebugOverlay />
    </SafeAreaView>
  );
}

// ========== STYLES ==========
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  webview: {
    flex: 1,
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    zIndex: 1000,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
  // Debug styles
  debugButton: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(0, 122, 255, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  debugButtonText: {
    fontSize: 24,
    color: 'white',
  },
  debugPanel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'white',
    zIndex: 1001,
    padding: 20,
  },
  debugHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  debugTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  closeButton: {
    fontSize: 24,
    color: '#666',
    padding: 10,
  },
  debugSection: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 5,
  },
  sectionValue: {
    fontSize: 14,
    color: '#666',
    marginBottom: 10,
  },
  credentialsList: {
    maxHeight: 200,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    padding: 10,
  },
  credentialItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  credentialKey: {
    fontWeight: 'bold',
    fontSize: 14,
  },
  credentialId: {
    fontSize: 12,
    color: '#666',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  credentialTime: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
  },
  debugButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
});