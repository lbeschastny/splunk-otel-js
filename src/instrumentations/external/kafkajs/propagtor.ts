/*
 * Copyright Splunk Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { TextMapGetter } from '@opentelemetry/api';

/*
same as open telemetry's `defaultTextMapGetter`, 
but also handle case where header is buffer, 
adding toString() to make sure string is returned
*/
export const bufferTextMapGetter: TextMapGetter = {
  get(carrier, key) {
    return carrier?.[key]?.toString();
  },

  keys(carrier) {
    return carrier ? Object.keys(carrier) : [];
  },
};
