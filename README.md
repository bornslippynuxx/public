The configuration for external OAuth providers in Airflow 3.0 with `apache-airflow-providers-fab` is quite similar to Airflow 2.x, but there are some important changes to be aware of.

## Key Changes in Airflow 3.0

In Airflow 3.0, FAB (Flask-AppBuilder) has been moved to a separate provider package (`apache-airflow-providers-fab`), but the OAuth configuration approach remains largely the same.

## Configuration Steps

Here's how to configure external OAuth in Airflow 3.0:

### 1. Install the FAB Provider

```bash
pip install apache-airflow-providers-fab
```

### 2. Configure airflow.cfg

```ini
[webserver]
rbac = True
auth_backend = airflow.providers.fab.auth_manager.fab_auth_manager.FabAuthManager

[fab]
auth_type = AUTH_OAUTH
oauth_providers = [
    {
        'name': 'your_provider',
        'icon': 'fa-circle-o',
        'token_key': 'access_token',
        'remote_app': {
            'client_id': 'YOUR_CLIENT_ID',
            'client_secret': 'YOUR_CLIENT_SECRET',
            'api_base_url': 'https://your-oauth-provider.com/api/',
            'client_kwargs': {
                'scope': 'openid profile email'
            },
            'access_token_url': 'https://your-oauth-provider.com/oauth/token',
            'authorize_url': 'https://your-oauth-provider.com/oauth/authorize',
            'request_token_url': None,
        }
    }
]
```

### 3. Create a Custom Security Manager

You'll likely still need a custom security manager in `webserver_config.py`:

```python
from airflow.providers.fab.auth_manager.security_manager.override import FabAirflowSecurityManagerOverride
from flask_appbuilder.security.manager import AUTH_OAUTH

class CustomSecurityManager(FabAirflowSecurityManagerOverride):
    
    def oauth_user_info(self, provider, response=None):
        """
        Get user info from OAuth provider
        """
        if provider == 'your_provider':
            # Extract user info from your OAuth provider's response
            me = self.appbuilder.sm.oauth_remotes[provider].get('userinfo')
            data = me.json()
            
            return {
                'username': data.get('preferred_username'),
                'email': data.get('email'),
                'first_name': data.get('given_name'),
                'last_name': data.get('family_name'),
                'role_keys': data.get('roles', [])  # Your role mapping
            }

SECURITY_MANAGER_CLASS = CustomSecurityManager
```

### 4. Role Mapping

Map OAuth roles to Airflow roles in your security manager:

```python
def auth_user_oauth(self, userinfo):
    """
    Map OAuth roles to Airflow roles
    """
    user = super().auth_user_oauth(userinfo)
    
    # Custom role mapping logic
    oauth_roles = userinfo.get('role_keys', [])
    airflow_roles = []
    
    if 'admin' in oauth_roles:
        airflow_roles.append(self.find_role('Admin'))
    elif 'viewer' in oauth_roles:
        airflow_roles.append(self.find_role('Viewer'))
    else:
        airflow_roles.append(self.find_role('Public'))
    
    user.roles = airflow_roles
    self.update_user(user)
    
    return user
```

## Important Notes for Airflow 3.0

1. **Provider Package**: Make sure you have the correct version of `apache-airflow-providers-fab` installed that's compatible with Airflow 3.0

2. **Auth Manager**: The auth manager configuration has changed slightly - ensure you're pointing to the FAB auth manager from the provider package

3. **Migration Path**: If migrating from 2.11, your existing OAuth configuration should mostly work, but test thoroughly in a non-production environment first

Yes, there are several known bugs and issues with OAuth authentication in Airflow 3.0 when using the `apache-airflow-providers-fab` package:

## Critical Issues

### 1. **HTTP vs HTTPS Redirect URI Problem** (Issue #49781)
The removal of the `AIRFLOW__WEBSERVER__ENABLE_PROXY_FIX` configuration option in Airflow 3.0 has broken OAuth sign-in with FAB. The redirect URI is being generated with HTTP instead of HTTPS, causing authentication failures due to redirect URI mismatches.

**Workaround**: In Airflow 2.x, this was solved by setting `AIRFLOW__WEBSERVER__ENABLE_PROXY_FIX = True`, but this option was removed in 3.0, leaving OAuth broken for deployments behind reverse proxies.

### 2. **Google OAuth Login Issues** (Issue #52226)
Users report being unable to login using FAB with Google OAuth in Airflow 3.0.2, encountering JWT token validation errors with the message "JWT token is not valid: The specified alg value is not allowed".

### 3. **API Authentication Confusion** (Issue #50684)
There's confusion about how API authentication works in Airflow 3.0 with the FAB provider. The `requires_authentication` decorator in custom API authentication backends appears to have become obsolete, and the documentation may be outdated regarding proper implementation methods.

### 4. **Database Users Cannot Authenticate with OAuth Configured** (Issue #51662)
When OAuth is configured as the primary authentication type, users created via the CLI command cannot authenticate through the API, even when basic auth backend is properly configured.

### 5. **LDAP JWT Token Generation Fails** (Issue #52103)
LDAP users cannot generate JWT tokens via the `/auth/token` endpoint in Airflow 3.0 with FAB auth manager, even though they can successfully log in through the web UI.

### 6. **Missing Dependencies**
The `authlib` module is required for OAuth but may not be automatically installed, causing import errors.

## Recommendations

1. **Monitor Issue #49781** closely - this is the most critical issue affecting OAuth deployments behind proxies
2. **Test thoroughly** in a non-production environment before migrating
3. Consider these workarounds:
   - For proxy issues: May need custom middleware to handle `X-Forwarded-Proto` headers
   - For missing dependencies: Explicitly install `authlib` package
4. **Check the redirect URI path** - In Airflow 3.0, the OAuth callback path changed from `/oauth-authorized/{provider}` to `/auth/oauth-authorized/{provider}`, so you'll need to update your OAuth provider configuration

Would you like me to search for more specific information about any of these issues or look for potential workarounds?

Would you like me to search for the most current documentation on specific OAuth provider configurations (like Okta, Azure AD, Google, etc.) for Airflow 3.0?
